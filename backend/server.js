import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import session from 'express-session';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import http from 'http';
import fetch from 'node-fetch';
import { ScannerService } from './ScannerService.js';
import { RSI, ADX, ATR, MACD, SMA, BollingerBands, EMA } from 'technicalindicators';


// --- Basic Setup ---
dotenv.config();
const app = express();
const port = process.env.PORT || 8080;
const server = http.createServer(app);

app.use(cors({
    origin: (origin, callback) => {
        // For development (e.g., Postman) or same-origin, origin is undefined.
        // In production, you might want to restrict this to your frontend's domain.
        callback(null, true);
    },
    credentials: true,
}));
app.use(bodyParser.json());
app.set('trust proxy', 1); // For Nginx

// --- Session Management ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'a_much_more_secure_and_random_secret_string_32_chars_long',
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24
    }
}));

// --- WebSocket Server for Frontend Communication ---
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();
server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    
    if (url.pathname === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});
wss.on('connection', (ws) => {
    clients.add(ws);
    log('WEBSOCKET', 'Frontend client connected.');

    // Immediately send the current Fear & Greed index if it exists
    if (botState.fearAndGreed) {
        ws.send(JSON.stringify({
            type: 'FEAR_AND_GREED_UPDATE',
            payload: botState.fearAndGreed
        }));
    }

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            log('WEBSOCKET', `Received message from client: ${JSON.stringify(data)}`);
            
            if (data.type === 'GET_FULL_SCANNER_LIST') {
                log('WEBSOCKET', 'Client requested full scanner list. Sending...');
                ws.send(JSON.stringify({
                    type: 'FULL_SCANNER_LIST',
                    payload: botState.scannerCache
                }));
            }
        } catch (e) {
            log('ERROR', `Failed to parse message from client: ${message}`);
        }
    });
    ws.on('close', () => {
        clients.delete(ws);
        log('WEBSOCKET', 'Frontend client disconnected.');
    });
    ws.on('error', (error) => {
        log('ERROR', `WebSocket client error: ${error.message}`);
        ws.close();
    });
});
function broadcast(message) {
    const data = JSON.stringify(message);
    if (['SCANNER_UPDATE', 'POSITIONS_UPDATED'].includes(message.type)) {
        log('WEBSOCKET', `Broadcasting ${message.type} to ${clients.size} clients.`);
    }
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
             client.send(data, (err) => {
                if (err) {
                    log('ERROR', `Failed to send message to a client: ${err.message}`);
                }
            });
        }
    }
}

// --- Logging Service ---
const log = (level, message) => {
    console.log(`[${level}] ${message}`);
    const logEntry = {
        type: 'LOG_ENTRY',
        payload: {
            timestamp: new Date().toISOString(),
            level,
            message
        }
    };
    broadcast(logEntry);
};

// --- Binance API Client ---
class BinanceApiClient {
    constructor(apiKey, secretKey, log) {
        this.apiKey = apiKey;
        this.secretKey = secretKey;
        this.baseUrl = 'https://api.binance.com';
        this.log = log;
    }

    _getSignature(queryString) {
        return crypto.createHmac('sha256', this.secretKey).update(queryString).digest('hex');
    }

    async _request(method, endpoint, params = {}) {
        const timestamp = Date.now();
        const queryString = new URLSearchParams({ ...params, timestamp }).toString();
        const signature = this._getSignature(queryString);
        const url = `${this.baseUrl}${endpoint}?${queryString}&signature=${signature}`;

        try {
            const response = await fetch(url, {
                method,
                headers: { 'X-MBX-APIKEY': this.apiKey }
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(`Binance API Error: ${data.msg || `HTTP ${response.status}`}`);
            }
            this.log('BINANCE_API', `[${method}] ${endpoint} successful.`);
            return data;
        } catch (error) {
            this.log('ERROR', `[BINANCE_API] [${method}] ${endpoint} failed: ${error.message}`);
            throw error;
        }
    }
    
    async getAccountInfo() {
        return this._request('GET', '/api/v3/account');
    }
    
    async createOrder(symbol, side, type, quantity) {
        const params = { symbol, side, type, quantity };
        return this._request('POST', '/api/v3/order', params);
    }
    
    async getExchangeInfo() {
        try {
            const response = await fetch(`${this.baseUrl}/api/v3/exchangeInfo`);
            const data = await response.json();
            this.log('BINANCE_API', `Successfully fetched exchange info for ${data.symbols.length} symbols.`);
            return data;
        } catch (error) {
             this.log('ERROR', `[BINANCE_API] Failed to fetch exchange info: ${error.message}`);
             throw error;
        }
    }
}
let binanceApiClient = null;
let symbolRules = new Map();

function formatQuantity(symbol, quantity) {
    const rules = symbolRules.get(symbol);
    if (!rules || !rules.stepSize) {
        // Fallback for symbols without explicit rules (e.g., if exchangeInfo fails)
        return parseFloat(quantity.toFixed(8));
    }

    if (rules.stepSize === 1) {
        return Math.floor(quantity);
    }

    // Calculate precision from stepSize (e.g., 0.001 -> 3)
    const precision = Math.max(0, Math.log10(1 / rules.stepSize));
    const factor = Math.pow(10, precision);
    return Math.floor(quantity * factor) / factor;
}


// --- Persistence ---
const DATA_DIR = path.join(process.cwd(), 'data');
const SETTINGS_FILE_PATH = path.join(DATA_DIR, 'settings.json');
const STATE_FILE_PATH = path.join(DATA_DIR, 'state.json');
const AUTH_FILE_PATH = path.join(DATA_DIR, 'auth.json');
const KLINE_DATA_DIR = path.join(DATA_DIR, 'klines');

const ensureDataDirs = async () => {
    try { await fs.access(DATA_DIR); } catch { await fs.mkdir(DATA_DIR); }
    try { await fs.access(KLINE_DATA_DIR); } catch { await fs.mkdir(KLINE_DATA_DIR); }
};

// --- Auth Helpers ---
const hashPassword = (password) => {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16).toString('hex');
        crypto.scrypt(password, salt, 64, (err, derivedKey) => {
            if (err) reject(err);
            resolve(salt + ":" + derivedKey.toString('hex'));
        });
    });
};

const verifyPassword = (password, hash) => {
    return new Promise((resolve, reject) => {
        const [salt, key] = hash.split(':');
        if (!salt || !key) {
            return reject(new Error('Invalid hash format.'));
        }
        crypto.scrypt(password, salt, 64, (err, derivedKey) => {
            if (err) reject(err);
            try {
                const keyBuffer = Buffer.from(key, 'hex');
                const match = crypto.timingSafeEqual(keyBuffer, derivedKey);
                resolve(match);
            } catch (e) {
                // Handle cases where the key is not valid hex, preventing crashes
                resolve(false);
            }
        });
    });
};


const loadData = async () => {
    await ensureDataDirs();
    try {
        const settingsContent = await fs.readFile(SETTINGS_FILE_PATH, 'utf-8');
        botState.settings = JSON.parse(settingsContent);
    } catch {
        log("WARN", "settings.json not found. Loading from .env defaults.");
        
        // Helper for boolean env vars: defaults to `true` unless explicitly 'false'
        const isNotFalse = (envVar) => process.env[envVar] !== 'false';
        // Helper for boolean env vars: defaults to `false` unless explicitly 'true'
        const isTrue = (envVar) => process.env[envVar] === 'true';

        botState.settings = {
            // Core Trading
            INITIAL_VIRTUAL_BALANCE: parseFloat(process.env.INITIAL_VIRTUAL_BALANCE) || 10000,
            MAX_OPEN_POSITIONS: parseInt(process.env.MAX_OPEN_POSITIONS, 10) || 5,
            POSITION_SIZE_PCT: parseFloat(process.env.POSITION_SIZE_PCT) || 2.0,
            RISK_REWARD_RATIO: parseFloat(process.env.RISK_REWARD_RATIO) || 4.0,
            STOP_LOSS_PCT: parseFloat(process.env.STOP_LOSS_PCT) || 2.0, // Fallback if ATR is disabled
            SLIPPAGE_PCT: parseFloat(process.env.SLIPPAGE_PCT) || 0.05,
            
            // Scanner & Filters
            MIN_VOLUME_USD: parseFloat(process.env.MIN_VOLUME_USD) || 40000000,
            SCANNER_DISCOVERY_INTERVAL_SECONDS: parseInt(process.env.SCANNER_DISCOVERY_INTERVAL_SECONDS, 10) || 3600,
            EXCLUDED_PAIRS: process.env.EXCLUDED_PAIRS || "USDCUSDT,FDUSDUSDT,TUSDUSDT,BUSDUSDT",
            LOSS_COOLDOWN_HOURS: parseInt(process.env.LOSS_COOLDOWN_HOURS, 10) || 4,
            
            // API Credentials
            BINANCE_API_KEY: process.env.BINANCE_API_KEY || '',
            BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY || '',

            // --- ADVANCED STRATEGY & RISK MANAGEMENT (Optimal Defaults) ---
            
            // ATR Stop Loss (Enabled by default)
            USE_ATR_STOP_LOSS: isNotFalse('USE_ATR_STOP_LOSS'),
            ATR_MULTIPLIER: parseFloat(process.env.ATR_MULTIPLIER) || 1.5,
            
            // Auto Break-even (Enabled by default)
            USE_AUTO_BREAKEVEN: isNotFalse('USE_AUTO_BREAKEVEN'),
            BREAKEVEN_TRIGGER_R: parseFloat(process.env.BREAKEVEN_TRIGGER_R) || 1.0,
            ADJUST_BREAKEVEN_FOR_FEES: isNotFalse('ADJUST_BREAKEVEN_FOR_FEES'),
            TRANSACTION_FEE_PCT: parseFloat(process.env.TRANSACTION_FEE_PCT) || 0.1,

            // Safety Filters (Enabled by default)
            USE_RSI_SAFETY_FILTER: isNotFalse('USE_RSI_SAFETY_FILTER'),
            RSI_OVERBOUGHT_THRESHOLD: parseInt(process.env.RSI_OVERBOUGHT_THRESHOLD, 10) || 75,
            USE_PARABOLIC_FILTER: isNotFalse('USE_PARABOLIC_FILTER'),
            PARABOLIC_FILTER_PERIOD_MINUTES: parseInt(process.env.PARABOLIC_FILTER_PERIOD_MINUTES, 10) || 5,
            PARABOLIC_FILTER_THRESHOLD_PCT: parseFloat(process.env.PARABOLIC_FILTER_THRESHOLD_PCT) || 2.5,
            USE_VOLUME_CONFIRMATION: isNotFalse('USE_VOLUME_CONFIRMATION'),
            USE_MARKET_REGIME_FILTER: isNotFalse('USE_MARKET_REGIME_FILTER'),

            // Optional Features (Disabled by default for simplicity)
            USE_PARTIAL_TAKE_PROFIT: isTrue('USE_PARTIAL_TAKE_PROFIT'),
            PARTIAL_TP_TRIGGER_PCT: parseFloat(process.env.PARTIAL_TP_TRIGGER_PCT) || 0.8,
            PARTIAL_TP_SELL_QTY_PCT: parseInt(process.env.PARTIAL_TP_SELL_QTY_PCT, 10) || 50,
            USE_DYNAMIC_POSITION_SIZING: isTrue('USE_DYNAMIC_POSITION_SIZING'),
            STRONG_BUY_POSITION_SIZE_PCT: parseFloat(process.env.STRONG_BUY_POSITION_SIZE_PCT) || 3.0,
            REQUIRE_STRONG_BUY: isTrue('REQUIRE_STRONG_BUY'),

            // --- ADAPTIVE BEHAVIOR (Enabled by default) ---
            USE_DYNAMIC_PROFILE_SELECTOR: isNotFalse('USE_DYNAMIC_PROFILE_SELECTOR'),
            ADX_THRESHOLD_RANGE: parseInt(process.env.ADX_THRESHOLD_RANGE, 10) || 20,
            ATR_PCT_THRESHOLD_VOLATILE: parseFloat(process.env.ATR_PCT_THRESHOLD_VOLATILE) || 5.0,
            USE_AGGRESSIVE_ENTRY_LOGIC: isTrue('USE_AGGRESSIVE_ENTRY_LOGIC'), // Profile-specific
            
            // Adaptive Trailing Stop (Enabled by default)
            USE_ADAPTIVE_TRAILING_STOP: isNotFalse('USE_ADAPTIVE_TRAILING_STOP'),
            TRAILING_STOP_TIGHTEN_THRESHOLD_R: parseFloat(process.env.TRAILING_STOP_TIGHTEN_THRESHOLD_R) || 1.0,
            TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION: parseFloat(process.env.TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION) || 0.3,

            // Graduated Circuit Breaker
            CIRCUIT_BREAKER_WARN_THRESHOLD_PCT: parseFloat(process.env.CIRCUIT_BREAKER_WARN_THRESHOLD_PCT) || 1.5,
            CIRCUIT_BREAKER_HALT_THRESHOLD_PCT: parseFloat(process.env.CIRCUIT_BREAKER_HALT_THRESHOLD_PCT) || 2.5,
            DAILY_DRAWDOWN_LIMIT_PCT: parseFloat(process.env.DAILY_DRAWDOWN_LIMIT_PCT) || 3.0,
            CONSECUTIVE_LOSS_LIMIT: parseInt(process.env.CONSECUTIVE_LOSS_LIMIT, 10) || 5,

            // --- ADVANCED ENTRY CONFIRMATION ---
            USE_MTF_VALIDATION: isTrue('USE_MTF_VALIDATION'),
            USE_OBV_VALIDATION: isNotFalse('USE_OBV_VALIDATION'),
            USE_CVD_FILTER: isTrue('USE_CVD_FILTER'),
            
            // --- NEW ADVANCED CONFIRMATION FILTERS ---
            USE_RSI_MTF_FILTER: isTrue('USE_RSI_MTF_FILTER'),
            RSI_15M_OVERBOUGHT_THRESHOLD: parseInt(process.env.RSI_15M_OVERBOUGHT_THRESHOLD, 10) || 70,
            USE_WICK_DETECTION_FILTER: isTrue('USE_WICK_DETECTION_FILTER'),
            MAX_UPPER_WICK_PCT: parseFloat(process.env.MAX_UPPER_WICK_PCT) || 50,
            USE_OBV_5M_VALIDATION: isTrue('USE_OBV_5M_VALIDATION'),
            
            // --- PORTFOLIO INTELLIGENCE ---
            SCALING_IN_CONFIG: process.env.SCALING_IN_CONFIG || "50,50",
            MAX_CORRELATED_TRADES: parseInt(process.env.MAX_CORRELATED_TRADES, 10) || 2,
            USE_FEAR_AND_GREED_FILTER: isTrue('USE_FEAR_AND_GREED_FILTER'),

            // --- ADVANCED PORTFOLIO FILTERS ---
            USE_ORDER_BOOK_LIQUIDITY_FILTER: isTrue('USE_ORDER_BOOK_LIQUIDITY_FILTER'),
            MIN_ORDER_BOOK_LIQUIDITY_USD: parseInt(process.env.MIN_ORDER_BOOK_LIQUIDITY_USD, 10) || 200000,
            USE_SECTOR_CORRELATION_FILTER: isTrue('USE_SECTOR_CORRELATION_FILTER'),
            USE_WHALE_MANIPULATION_FILTER: isTrue('USE_WHALE_MANIPULATION_FILTER'),
            WHALE_SPIKE_THRESHOLD_PCT: parseFloat(process.env.WHALE_SPIKE_THRESHOLD_PCT) || 5.0,

            // --- EXPERIMENTAL STRATEGIES ---
            USE_IGNITION_STRATEGY: isTrue('USE_IGNITION_STRATEGY'),
            IGNITION_PRICE_THRESHOLD_PCT: parseFloat(process.env.IGNITION_PRICE_THRESHOLD_PCT) || 5.0,
            IGNITION_VOLUME_MULTIPLIER: parseInt(process.env.IGNITION_VOLUME_MULTIPLIER, 10) || 10,
            USE_FLASH_TRAILING_STOP: isTrue('USE_FLASH_TRAILING_STOP'),
            FLASH_TRAILING_STOP_PCT: parseFloat(process.env.FLASH_TRAILING_STOP_PCT) || 1.5,
        };
        await saveData('settings');
    }
    try {
        const stateContent = await fs.readFile(STATE_FILE_PATH, 'utf-8');
        const persistedState = JSON.parse(stateContent);
        botState.balance = persistedState.balance || botState.settings.INITIAL_VIRTUAL_BALANCE;
        botState.activePositions = persistedState.activePositions || [];
        botState.tradeHistory = persistedState.tradeHistory || [];
        botState.tradeIdCounter = persistedState.tradeIdCounter || 1;
        botState.isRunning = persistedState.isRunning !== undefined ? persistedState.isRunning : true;
        botState.tradingMode = persistedState.tradingMode || 'VIRTUAL';
        botState.dayStartBalance = persistedState.dayStartBalance || botState.settings.INITIAL_VIRTUAL_BALANCE;
        botState.dailyPnl = persistedState.dailyPnl || 0;
        botState.consecutiveLosses = persistedState.consecutiveLosses || 0;
        botState.consecutiveWins = persistedState.consecutiveWins || 0;
        botState.currentTradingDay = persistedState.currentTradingDay || new Date().toISOString().split('T')[0];
    } catch {
        log("WARN", "state.json not found. Initializing default state.");
        botState.balance = botState.settings.INITIAL_VIRTUAL_BALANCE;
        botState.dayStartBalance = botState.settings.INITIAL_VIRTUAL_BALANCE;
        await saveData('state');
    }

    try {
        const authContent = await fs.readFile(AUTH_FILE_PATH, 'utf-8');
        const authData = JSON.parse(authContent);
        if (authData.passwordHash) {
            botState.passwordHash = authData.passwordHash;
        } else {
            throw new Error("Invalid auth file format");
        }
    } catch {
        log("WARN", "auth.json not found or invalid. Initializing from .env.");
        const initialPassword = process.env.APP_PASSWORD;
        if (!initialPassword) {
            log('ERROR', 'CRITICAL: APP_PASSWORD is not set in .env file. Please set it and restart.');
            process.exit(1);
        }
        botState.passwordHash = await hashPassword(initialPassword);
        await fs.writeFile(AUTH_FILE_PATH, JSON.stringify({ passwordHash: botState.passwordHash }, null, 2));
        log('INFO', 'Created auth.json with a new secure password hash.');
    }
    
    realtimeAnalyzer.updateSettings(botState.settings);
};

const saveData = async (type) => {
    await ensureDataDirs();
    if (type === 'settings') {
        await fs.writeFile(SETTINGS_FILE_PATH, JSON.stringify(botState.settings, null, 2));
    } else if (type === 'state') {
        const stateToPersist = {
            balance: botState.balance,
            activePositions: botState.activePositions,
            tradeHistory: botState.tradeHistory,
            tradeIdCounter: botState.tradeIdCounter,
            isRunning: botState.isRunning,
            tradingMode: botState.tradingMode,
            dayStartBalance: botState.dayStartBalance,
            dailyPnl: botState.dailyPnl,
            consecutiveLosses: botState.consecutiveLosses,
            consecutiveWins: botState.consecutiveWins,
            currentTradingDay: botState.currentTradingDay,
        };
        await fs.writeFile(STATE_FILE_PATH, JSON.stringify(stateToPersist, null, 2));
    } else if (type === 'auth') {
        await fs.writeFile(AUTH_FILE_PATH, JSON.stringify({ passwordHash: botState.passwordHash }, null, 2));
    }
};

// --- Custom OBV Calculator ---
const calculateOBV = (klines) => {
    if (!klines || klines.length < 2) return [];
    let obv = [0];
    for (let i = 1; i < klines.length; i++) {
        const currentClose = klines[i].close;
        const prevClose = klines[i - 1].close;
        const volume = klines[i].volume;
        if (currentClose > prevClose) {
            obv.push(obv[i - 1] + volume);
        } else if (currentClose < prevClose) {
            obv.push(obv[i - 1] - volume);
        } else {
            obv.push(obv[i - 1]);
        }
    }
    return obv;
};

// --- Custom CVD Calculator (approximated from klines) ---
const calculateCVD = (klines) => {
    if (!klines || klines.length < 1) return [];
    let cvd = [0]; // Start with a baseline of 0
    for (let i = 1; i < klines.length; i++) {
        const volumeDelta = klines[i].close > klines[i].open ? klines[i].volume : (klines[i].close < klines[i].open ? -klines[i].volume : 0);
        cvd.push(cvd[i - 1] + volumeDelta);
    }
    return cvd;
};

// --- Realtime Analysis Engine (Macro-Micro Strategy) ---
class RealtimeAnalyzer {
    constructor(log) {
        this.log = log;
        this.settings = {};
        this.klineData = new Map(); // Map<symbol, Map<interval, kline[]>>
        this.hydrating = new Set();
        this.SQUEEZE_PERCENTILE_THRESHOLD = 0.25;
        this.SQUEEZE_LOOKBACK = 50;
    }

    updateSettings(newSettings) {
        this.log('INFO', '[Analyzer] Settings updated for Macro-Micro strategy.');
        this.settings = newSettings;
    }

    // Phase 1: 15m analysis to qualify pairs for the Hotlist (HYBRID ENGINE)
    analyze15mIndicators(symbolOrPair) {
        const symbol = typeof symbolOrPair === 'string' ? symbolOrPair : symbolOrPair.symbol;
        const pairToUpdate = typeof symbolOrPair === 'string'
            ? botState.scannerCache.find(p => p.symbol === symbol)
            : symbolOrPair;

        if (!pairToUpdate) return;

        const klines15m = this.klineData.get(symbol)?.get('15m');
        if (!klines15m || klines15m.length < this.SQUEEZE_LOOKBACK) return;

        const old_score = pairToUpdate.score;
        const old_hotlist_status = pairToUpdate.is_on_hotlist;

        const closes15m = klines15m.map(d => d.close);
        const highs15m = klines15m.map(d => d.high);
        const lows15m = klines15m.map(d => d.low);

        const bbResult = BollingerBands.calculate({ period: 20, values: closes15m, stdDev: 2 });
        const atrResult = ATR.calculate({ high: highs15m, low: lows15m, close: closes15m, period: 14 });
        const adxResult = ADX.calculate({ high: highs15m, low: lows15m, close: closes15m, period: 14 });
        const rsi15m = RSI.calculate({ period: 14, values: closes15m }).pop();

        if (bbResult.length < 2 || !atrResult.length) return;

        const lastCandle = klines15m[klines15m.length - 1];
        
        // --- UPDATE BASE INDICATORS ---
        pairToUpdate.atr_15m = atrResult[atrResult.length - 1];
        pairToUpdate.adx_15m = adxResult.length ? adxResult[adxResult.length - 1].adx : undefined;
        pairToUpdate.atr_pct_15m = pairToUpdate.atr_15m ? (pairToUpdate.atr_15m / lastCandle.close) * 100 : undefined;
        pairToUpdate.rsi_15m = rsi15m;
        
        const lastBB = bbResult[bbResult.length - 1];
        const currentBbWidthPct = (lastBB.upper - lastBB.lower) / lastBB.middle * 100;
        pairToUpdate.bollinger_bands_15m = { ...lastBB, width_pct: currentBbWidthPct };
        
        const volumes15m = klines15m.map(k => k.volume);
        const avgVolume = volumes15m.slice(-21, -1).reduce((sum, v) => sum + v, 0) / 20;
        pairToUpdate.volume_20_period_avg_15m = avgVolume;

        // --- HYBRID STRATEGY DECISION LOGIC ---
        const isTrendOK = pairToUpdate.price_above_ema50_4h === true;
        let finalScore = 'HOLD';
        let strategyType = undefined;
        let isOnHotlist = false;

        // --- STRATEGY 1: MOMENTUM (IMPULSE) CHECK (🔥) ---
        const bodySize = Math.abs(lastCandle.close - lastCandle.open);
        const isImpulseBody = pairToUpdate.atr_15m > 0 && bodySize > pairToUpdate.atr_15m * 1.5;
        const isImpulseVolume = avgVolume > 0 && lastCandle.volume > avgVolume * 2.0;
        const isBullishCandle = lastCandle.close > lastCandle.open;
        const isMomentumSignal = isTrendOK && isImpulseBody && isImpulseVolume && isBullishCandle;
        
        if (isMomentumSignal) {
            strategyType = 'MOMENTUM';
            finalScore = 'PENDING_CONFIRMATION';
            isOnHotlist = true;
            
            // Immediately set up for 5m confirmation
            let tradeSettings = { ...this.settings };
            if (this.settings.USE_DYNAMIC_PROFILE_SELECTOR) {
                if (pairToUpdate.adx_15m < tradeSettings.ADX_THRESHOLD_RANGE) {
                    tradeSettings = { ...tradeSettings, ...settingProfiles['Le Scalpeur'] };
                } else if (pairToUpdate.atr_pct_15m > tradeSettings.ATR_PCT_THRESHOLD_VOLATILE) {
                    tradeSettings = { ...tradeSettings, ...settingProfiles['Le Chasseur de Volatilité'] };
                } else {
                    tradeSettings = { ...tradeSettings, ...settingProfiles['Le Sniper'] };
                }
            }
            botState.pendingConfirmation.set(symbol, {
                triggerPrice: lastCandle.close,
                triggerTimestamp: Date.now(),
                slPriceReference: lastCandle.low,
                settings: tradeSettings,
                strategy_type: 'MOMENTUM'
            });
            this.log('TRADE', `[MOMENTUM 🔥 15m] Signal for ${symbol}. Pending 5m confirmation.`);
        } 
        // --- STRATEGY 2: PRECISION (SQUEEZE) CHECK (🎯) ---
        else {
            const bbWidths = bbResult.map(b => (b.upper - b.lower) / b.middle);
            const prevBbWidth = bbWidths[bbWidths.length - 2];
            const historyForSqueeze = bbWidths.slice(0, -1).slice(-this.SQUEEZE_LOOKBACK);
            
            let wasInSqueeze = false;
            if (historyForSqueeze.length >= 20) {
                const sortedWidths = [...historyForSqueeze].sort((a, b) => a - b);
                const squeezeThreshold = sortedWidths[Math.floor(sortedWidths.length * this.SQUEEZE_PERCENTILE_THRESHOLD)];
                wasInSqueeze = prevBbWidth <= squeezeThreshold;
            }
            pairToUpdate.is_in_squeeze_15m = wasInSqueeze;
            const isPrecisionSignal = isTrendOK && wasInSqueeze;

            if (isPrecisionSignal) {
                strategyType = 'PRECISION';
                finalScore = 'COMPRESSION';
                isOnHotlist = true;
            }
        }

        // --- FINAL STATE UPDATE ---
        pairToUpdate.strategy_type = strategyType;
        pairToUpdate.is_on_hotlist = isOnHotlist;
        
        if (isOnHotlist && !old_hotlist_status) {
            this.log('SCANNER', `[HOTLIST ADD] ${symbol} now meets criteria for strategy: ${strategyType}. Watching on micro TFs.`);
            addSymbolToMicroStreams(symbol);
        } else if (!isOnHotlist && old_hotlist_status) {
            this.log('SCANNER', `[HOTLIST REMOVE] ${symbol} no longer meets criteria.`);
            removeSymbolFromMicroStreams(symbol);
        }

        // Handle cooldown override
        if (botState.recentlyLostSymbols.has(symbol)) {
            finalScore = 'COOLDOWN';
        }
        
        // Handle pending confirmation state
        if (botState.pendingConfirmation.has(symbol)) {
            finalScore = 'PENDING_CONFIRMATION';
        }

        pairToUpdate.score = finalScore;
        
        const isBreakout = lastCandle.close > lastBB.upper;
        const structureConditionMet = pairToUpdate.price > (klines15m[klines15m.length - 2]?.high || 0);

        const conditions = {
            trend: isTrendOK,
            squeeze: pairToUpdate.is_in_squeeze_15m,
            safety: pairToUpdate.rsi_1h !== undefined && pairToUpdate.rsi_1h < this.settings.RSI_OVERBOUGHT_THRESHOLD,
            rsi_mtf: pairToUpdate.rsi_15m !== undefined && pairToUpdate.rsi_15m < this.settings.RSI_15M_OVERBOUGHT_THRESHOLD,
            breakout: isBreakout,
            volume: lastCandle.volume > avgVolume * 2,
            structure: structureConditionMet,
            obv: false,
            cvd_5m_trending_up: false,
            momentum_impulse: isMomentumSignal
        };
        pairToUpdate.conditions = conditions;
        pairToUpdate.conditions_met_count = Object.values(conditions).filter(Boolean).length;
        pairToUpdate.score_value = (pairToUpdate.conditions_met_count / 8) * 100;

        if (pairToUpdate.score !== old_score || pairToUpdate.is_on_hotlist !== old_hotlist_status) {
            broadcast({ type: 'SCANNER_UPDATE', payload: pairToUpdate });
        }
    }
    
    async checkFor1mIgnitionTrigger(symbol, tradeSettings) {
        if (!tradeSettings.USE_IGNITION_STRATEGY) return false;

        const pair = botState.scannerCache.find(p => p.symbol === symbol);
        // Don't trigger if a position is already open, on cooldown, or pending confirmation
        if (!pair || botState.activePositions.some(p => p.symbol === symbol) || botState.recentlyLostSymbols.has(symbol) || botState.pendingConfirmation.has(symbol)) {
            return false;
        }

        const klines1m = this.klineData.get(symbol)?.get('1m');
        if (!klines1m || klines1m.length < 21) return false; // Need some history for volume average

        const triggerCandle = klines1m[klines1m.length - 1];
        const volumes1m = klines1m.map(k => k.volume);
        const avgVolume = volumes1m.slice(-21, -1).reduce((sum, v) => sum + v, 0) / 20;

        // Condition 1: Price Spike
        const priceIncreasePct = ((triggerCandle.close - triggerCandle.open) / triggerCandle.open) * 100;
        const priceConditionMet = priceIncreasePct >= tradeSettings.IGNITION_PRICE_THRESHOLD_PCT;

        // Condition 2: Volume Spike
        const volumeMultiplier = avgVolume > 0 ? triggerCandle.volume / avgVolume : 0;
        const volumeConditionMet = volumeMultiplier >= tradeSettings.IGNITION_VOLUME_MULTIPLIER;

        if (priceConditionMet && volumeConditionMet) {
            this.log('TRADE', `[IGNITION 🚀 1m] Trigger for ${symbol}! Price Spike: ${priceIncreasePct.toFixed(2)}%, Volume x${volumeMultiplier.toFixed(1)}. Attempting trade.`);
            
            // Mark the pair with the correct strategy type before passing to the engine
            pair.strategy_type = 'IGNITION';

            const tradeOpened = await tradingEngine.evaluateAndOpenTrade(pair, triggerCandle.low, tradeSettings);
            if (tradeOpened) {
                pair.is_on_hotlist = false; // An ignition trade consumes the opportunity
                removeSymbolFromMicroStreams(symbol);
                broadcast({ type: 'SCANNER_UPDATE', payload: pair });
            }
            return true; // Signal that a trade was attempted
        }

        return false;
    }

    // Phase 2: 1m analysis to find the precision entry for pairs on the Hotlist
    async checkFor1mTrigger(symbol, tradeSettings) {
        const pair = botState.scannerCache.find(p => p.symbol === symbol);
        // This trigger is ONLY for the PRECISION strategy.
        if (!pair || !pair.is_on_hotlist || pair.strategy_type !== 'PRECISION' || botState.pendingConfirmation.has(symbol)) return;

        const klines1m = this.klineData.get(symbol)?.get('1m');
        if (!klines1m || klines1m.length < 61) return;

        const closes1m = klines1m.map(k => k.close);
        const volumes1m = klines1m.map(k => k.volume);
        const lastEma9 = EMA.calculate({ period: 9, values: closes1m }).pop();
        const avgVolume = volumes1m.slice(-21, -1).reduce((sum, v) => sum + v, 0) / 20;

        if (lastEma9 === undefined) return;
        
        const triggerCandle = klines1m[klines1m.length - 1];
        
        // --- ADVANCED ANTI-FAKE OUT FILTERS ---
        if (tradeSettings.USE_RSI_MTF_FILTER) {
            if (pair.rsi_15m === undefined || pair.rsi_15m >= tradeSettings.RSI_15M_OVERBOUGHT_THRESHOLD) {
                log('TRADE', `[RSI MTF FILTER] Rejected ${symbol}. 15m RSI (${pair.rsi_15m?.toFixed(1)}) is over threshold (${tradeSettings.RSI_15M_OVERBOUGHT_THRESHOLD}).`);
                return;
            }
        }

        if (tradeSettings.USE_WICK_DETECTION_FILTER) {
            const candleHeight = triggerCandle.high - triggerCandle.low;
            if (candleHeight > 0) {
                const upperWick = triggerCandle.high - triggerCandle.close;
                const wickPercentage = (upperWick / candleHeight) * 100;
                if (wickPercentage > tradeSettings.MAX_UPPER_WICK_PCT) {
                    log('TRADE', `[WICK FILTER] Rejected ${symbol}. Upper wick (${wickPercentage.toFixed(1)}%) exceeds threshold (${tradeSettings.MAX_UPPER_WICK_PCT}%).`);
                    return;
                }
            }
        }
        
        if (tradeSettings.USE_WHALE_MANIPULATION_FILTER) {
            const last60mVolumes = volumes1m.slice(-61, -1);
            const hourlyAvgVolume = last60mVolumes.reduce((sum, v) => sum + v, 0) / 60;
            const thresholdVolume = hourlyAvgVolume * (tradeSettings.WHALE_SPIKE_THRESHOLD_PCT / 100);
            if (triggerCandle.volume > thresholdVolume) {
                log('TRADE', `[WHALE FILTER] Rejected ${symbol}. 1m volume (${triggerCandle.volume.toFixed(0)}) exceeded threshold (${thresholdVolume.toFixed(0)}).`);
                return;
            }
        }

        // --- CORE TRIGGER CONDITIONS ---
        const momentumCondition = triggerCandle.close > lastEma9;
        const volumeSpikeCondition = triggerCandle.volume > avgVolume * 1.5;

        let obvCondition = true;
        if (tradeSettings.USE_OBV_VALIDATION) {
            const obvValues = calculateOBV(klines1m);
            if (obvValues.length > 5) {
                const lastObv = obvValues[obvValues.length - 1];
                const obvSma = SMA.calculate({ period: 5, values: obvValues }).pop();
                obvCondition = lastObv > obvSma;
            } else {
                obvCondition = false;
            }
        }
        
        pair.conditions.obv = obvCondition;

        if (momentumCondition && volumeSpikeCondition && obvCondition) {
            this.log('TRADE', `[PRECISION 🎯 1m] Trigger for ${symbol}. Momentum, Volume, OBV all OK.`);
            
            if (tradeSettings.USE_MTF_VALIDATION) {
                pair.score = 'PENDING_CONFIRMATION';
                botState.pendingConfirmation.set(symbol, {
                    triggerPrice: triggerCandle.close,
                    triggerTimestamp: Date.now(),
                    slPriceReference: triggerCandle.low,
                    settings: tradeSettings,
                    strategy_type: 'PRECISION', // Explicitly set strategy type
                });
                this.log('TRADE', `[MTF] ${symbol} is now pending 5m confirmation for PRECISION strategy.`);
            } else {
                const tradeOpened = await tradingEngine.evaluateAndOpenTrade(pair, triggerCandle.low, tradeSettings);
                if (tradeOpened) {
                    pair.is_on_hotlist = false;
                    removeSymbolFromMicroStreams(symbol);
                }
            }
            broadcast({ type: 'SCANNER_UPDATE', payload: pair });
        }
    }

    async validate5mConfirmation(symbol, new5mCandle) {
        const pendingSignal = botState.pendingConfirmation.get(symbol);
        if (!pendingSignal) return;
        
        const pair = botState.scannerCache.find(p => p.symbol === symbol);
        if (!pair) return;

        const { triggerPrice, slPriceReference, settings, strategy_type } = pendingSignal;
        
        let isValid = false;
        let reason = "";

        if (strategy_type === 'MOMENTUM') {
            const isBullishContinuation = new5mCandle.close > new5mCandle.open;
            const klines5m = this.klineData.get(symbol)?.get('5m');
            let hasSustainedVolume = false;
            if (klines5m && klines5m.length > 10) {
                const volumes5m = klines5m.map(k => k.volume);
                const avgVolume5m = volumes5m.slice(-11, -1).reduce((s, v) => s + v, 0) / 10;
                hasSustainedVolume = new5mCandle.volume > avgVolume5m;
            }
            isValid = isBullishContinuation && hasSustainedVolume;
            reason = `5m candle did not confirm. Bullish: ${isBullishContinuation}, Volume: ${hasSustainedVolume}`;

        } else { // Default to PRECISION logic
            let obv5mCondition = true;
            if (settings.USE_OBV_5M_VALIDATION) {
                const klines5m = this.klineData.get(symbol)?.get('5m');
                if (klines5m && klines5m.length > 5) {
                    const obvValues = calculateOBV(klines5m);
                    const lastObv = obvValues.pop();
                    const obvSma = SMA.calculate({ period: 5, values: obvValues }).pop();
                    obv5mCondition = lastObv > obvSma;
                } else {
                    obv5mCondition = false;
                }
            }

            let cvd5mCondition = true;
            if (settings.USE_CVD_FILTER) {
                cvd5mCondition = pair.conditions?.cvd_5m_trending_up === true;
            }
            
            const candleIsValid = new5mCandle.close > triggerPrice && new5mCandle.close > new5mCandle.open;
            isValid = candleIsValid && obv5mCondition && cvd5mCondition;

            if (!candleIsValid) reason = "5m candle did not confirm";
            else if (!obv5mCondition) reason = "5m OBV did not confirm";
            else if (!cvd5mCondition) reason = "5m CVD did not confirm";
        }
        
        if (isValid) {
            this.log('TRADE', `[MTF SUCCESS - ${strategy_type}] 5m candle for ${symbol} confirmed breakout. Proceeding.`);
            const tradeOpened = await tradingEngine.evaluateAndOpenTrade(pair, slPriceReference, settings);
            if (tradeOpened) {
                pair.is_on_hotlist = false;
                removeSymbolFromMicroStreams(symbol);
            }
        } else {
            this.log('TRADE', `[MTF FAILED - ${strategy_type}] ${reason} for ${symbol}. Invalidating signal.`);
            pair.score = 'FAKE_BREAKOUT';
        }
        
        botState.pendingConfirmation.delete(symbol);
        broadcast({ type: 'SCANNER_UPDATE', payload: pair });
    }


    async hydrateSymbol(symbol, interval = '15m') {
        const klineLimit = interval === '1m' ? 100 : (interval === '5m' ? 50 : 201);
        if (this.hydrating.has(`${symbol}-${interval}`)) return;
        this.hydrating.add(`${symbol}-${interval}`);
        this.log('INFO', `[Analyzer] Hydrating ${interval} klines for: ${symbol}`);
        try {
            const klines = await scanner.fetchKlinesFromBinance(symbol, interval, 0, klineLimit);
            if (klines.length === 0) throw new Error(`No ${interval} klines fetched.`);
            const formattedKlines = klines.map(k => ({
                openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
                low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
                closeTime: k[6],
            }));

            if (!this.klineData.has(symbol)) this.klineData.set(symbol, new Map());
            this.klineData.get(symbol).set(interval, formattedKlines);
            
            if (interval === '15m') this.analyze15mIndicators(symbol);

        } catch (error) {
            this.log('ERROR', `Failed to hydrate ${symbol} (${interval}): ${error.message}`);
        } finally {
            this.hydrating.delete(`${symbol}-${interval}`);
        }
    }

    async handleNewKline(symbol, interval, kline) {
        if(symbol === 'BTCUSDT' && interval === '1m' && kline.closeTime) {
            checkGlobalSafetyRules();
        }

        log('BINANCE_WS', `[${interval} KLINE] Received for ${symbol}. Close: ${kline.close}`);
        if (!this.klineData.has(symbol) || !this.klineData.get(symbol).has(interval)) {
            this.hydrateSymbol(symbol, interval);
            return;
        }

        const klines = this.klineData.get(symbol).get(interval);
        klines.push(kline);
        if (klines.length > 201) klines.shift();
        
        if (interval === '15m') {
            this.analyze15mIndicators(symbol);
        } else if (interval === '5m') {
            // 1. Validate pending confirmations for trades (both PRECISION and MOMENTUM)
            this.validate5mConfirmation(symbol, kline);

            // 2. Update CVD status for UI on all hotlist pairs
            const pair = botState.scannerCache.find(p => p.symbol === symbol);
            if (pair && pair.is_on_hotlist) {
                const klines5m = this.klineData.get(symbol)?.get('5m');
                if (klines5m && klines5m.length > 10) {
                     const cvdValues = calculateCVD(klines5m);
                     const lastCvd = cvdValues[cvdValues.length - 1];
                     const cvdSma = SMA.calculate({ period: 5, values: cvdValues }).pop();
                     const cvdIsTrendingUp = lastCvd > cvdSma;
                     if (pair.conditions.cvd_5m_trending_up !== cvdIsTrendingUp) {
                         pair.conditions.cvd_5m_trending_up = cvdIsTrendingUp;
                         broadcast({ type: 'SCANNER_UPDATE', payload: pair });
                     }
                }
            }
        } else if (interval === '1m') {
            // Get correct settings profile for this specific moment
            let tradeSettings = { ...botState.settings };
            if (botState.settings.USE_DYNAMIC_PROFILE_SELECTOR) {
                const pair = botState.scannerCache.find(p => p.symbol === symbol);
                if(pair) {
                    if (pair.adx_15m !== undefined && pair.adx_15m < tradeSettings.ADX_THRESHOLD_RANGE) {
                        tradeSettings = { ...tradeSettings, ...settingProfiles['Le Scalpeur'] };
                    } else if (pair.atr_pct_15m !== undefined && pair.atr_pct_15m > tradeSettings.ATR_PCT_THRESHOLD_VOLATILE) {
                        tradeSettings = { ...tradeSettings, ...settingProfiles['Le Chasseur de Volatilité'] };
                    } else {
                        tradeSettings = { ...tradeSettings, ...settingProfiles['Le Sniper'] };
                    }
                }
            }

            // High-priority check for Ignition strategy
            const ignitionTriggered = await this.checkFor1mIgnitionTrigger(symbol, tradeSettings);
            
            if (!ignitionTriggered) {
                // Check for Precision trade triggers if Ignition did not fire
                this.checkFor1mTrigger(symbol, tradeSettings);

                // Check for scaling-in confirmations on existing trades
                if (tradeSettings.SCALING_IN_CONFIG && tradeSettings.SCALING_IN_CONFIG.trim() !== '') {
                    const position = botState.activePositions.find(p => p.symbol === symbol && p.is_scaling_in);
                    if (position && kline.close > kline.open) { // Bullish confirmation candle
                        tradingEngine.scaleInPosition(position, kline.close, tradeSettings);
                    }
                }
            }
        }
    }
}
const realtimeAnalyzer = new RealtimeAnalyzer(log);


// --- Binance WebSocket for Real-time Kline Data ---
let binanceWs = null;
const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws';
const subscribedStreams = new Set();
let reconnectBinanceWsTimeout = null;

function connectToBinanceStreams() {
    if (binanceWs && (binanceWs.readyState === WebSocket.OPEN || binanceWs.readyState === WebSocket.CONNECTING)) {
        return;
    }
    if (reconnectBinanceWsTimeout) clearTimeout(reconnectBinanceWsTimeout);

    log('BINANCE_WS', 'Connecting to Binance streams...');
    binanceWs = new WebSocket(BINANCE_WS_URL);

    binanceWs.on('open', () => {
        log('BINANCE_WS', 'Connected. Subscribing to streams...');
        if (subscribedStreams.size > 0) {
            const streams = Array.from(subscribedStreams);
            const payload = { method: "SUBSCRIBE", params: streams, id: 1 };
            binanceWs.send(JSON.stringify(payload));
            log('BINANCE_WS', `Resubscribed to ${streams.length} streams.`);
        }
    });

    binanceWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.e === 'kline') {
                const { s: symbol, k: kline } = msg;
                if (kline.x) { // is closed kline
                     const formattedKline = {
                        openTime: kline.t, open: parseFloat(kline.o), high: parseFloat(kline.h),
                        low: parseFloat(kline.l), close: parseFloat(kline.c), volume: parseFloat(kline.v),
                        closeTime: kline.T,
                    };
                    realtimeAnalyzer.handleNewKline(symbol, kline.i, formattedKline);
                }
            } else if (msg.e === '24hrTicker') {
                const symbol = msg.s;
                const newPrice = parseFloat(msg.c);
                const newVolume = parseFloat(msg.q); // Total traded quote asset volume for last 24h

                // 1. Update the central price cache for PnL calculations etc.
                botState.priceCache.set(symbol, { price: newPrice });

                // 2. Update the scanner cache if the pair exists there
                const updatedPair = botState.scannerCache.find(p => p.symbol === symbol);
                if (updatedPair) {
                    const oldPrice = updatedPair.price;
                    updatedPair.price = newPrice;
                    updatedPair.volume = newVolume; // Update the volume in real-time
                    updatedPair.priceDirection = newPrice > oldPrice ? 'up' : newPrice < oldPrice ? 'down' : (updatedPair.priceDirection || 'neutral');
                    
                    // Broadcast a full update for this pair to update the entire row in the scanner UI.
                    broadcast({ type: 'SCANNER_UPDATE', payload: updatedPair });
                }

                // 3. Also broadcast the simple PRICE_UPDATE for other parts of the app that only care about price (like PnL calculation).
                broadcast({ type: 'PRICE_UPDATE', payload: {symbol: symbol, price: newPrice } });
            }
        } catch (e) {
            log('ERROR', `Error processing Binance WS message: ${e.message}`);
        }
    });

    binanceWs.on('close', () => {
        log('WARN', 'Binance WebSocket disconnected. Reconnecting in 5s...');
        binanceWs = null;
        reconnectBinanceWsTimeout = setTimeout(connectToBinanceStreams, 5000);
    });
    binanceWs.on('error', (err) => log('ERROR', `Binance WebSocket error: ${err.message}`));
}

function updateBinanceSubscriptions(baseSymbols) {
    const symbolsFromScanner = new Set(baseSymbols);
    const symbolsFromPositions = new Set(botState.activePositions.map(p => p.symbol));

    // Union of both sets to ensure we get price updates for all relevant pairs
    const allSymbolsForTickers = new Set([...symbolsFromScanner, ...symbolsFromPositions]);

    const newStreams = new Set();
    
    // Ticker stream for ALL monitored symbols (scanner + positions)
    allSymbolsForTickers.forEach(s => {
        newStreams.add(`${s.toLowerCase()}@ticker`);
    });

    // 15m kline stream ONLY for pairs in the active scanner
    symbolsFromScanner.forEach(s => {
        newStreams.add(`${s.toLowerCase()}@kline_15m`);
    });
    
    // 1m & 5m kline streams ONLY for pairs on the hotlist
    botState.hotlist.forEach(s => {
        newStreams.add(`${s.toLowerCase()}@kline_1m`);
        newStreams.add(`${s.toLowerCase()}@kline_5m`);
    });

    // Always subscribe to BTCUSDT 1m kline for circuit breaker
    newStreams.add('btcusdt@kline_1m');

    const streamsToUnsub = [...subscribedStreams].filter(s => !newStreams.has(s));
    const streamsToSub = [...newStreams].filter(s => !subscribedStreams.has(s));

    if (binanceWs && binanceWs.readyState === WebSocket.OPEN) {
        if (streamsToUnsub.length > 0) {
            binanceWs.send(JSON.stringify({ method: "UNSUBSCRIBE", params: streamsToUnsub, id: 2 }));
            log('BINANCE_WS', `Unsubscribed from ${streamsToUnsub.length} streams.`);
        }
        if (streamsToSub.length > 0) {
            binanceWs.send(JSON.stringify({ method: "SUBSCRIBE", params: streamsToSub, id: 3 }));
            log('BINANCE_WS', `Subscribed to ${streamsToSub.length} new streams.`);
        }
    }

    subscribedStreams.clear();
    newStreams.forEach(s => subscribedStreams.add(s));
}

function addSymbolToMicroStreams(symbol) {
    botState.hotlist.add(symbol);
    const streamsToAdd = [`${symbol.toLowerCase()}@kline_1m`, `${symbol.toLowerCase()}@kline_5m`];
    const newStreams = streamsToAdd.filter(s => !subscribedStreams.has(s));
    
    if (newStreams.length > 0) {
        newStreams.forEach(s => subscribedStreams.add(s));
        if (binanceWs && binanceWs.readyState === WebSocket.OPEN) {
            binanceWs.send(JSON.stringify({ method: "SUBSCRIBE", params: newStreams, id: Date.now() }));
            log('BINANCE_WS', `Dynamically subscribed to micro streams for ${symbol}.`);
        }
        realtimeAnalyzer.hydrateSymbol(symbol, '1m');
        realtimeAnalyzer.hydrateSymbol(symbol, '5m');
    }
}

function removeSymbolFromMicroStreams(symbol) {
    botState.hotlist.delete(symbol);
    const streamsToRemove = [`${symbol.toLowerCase()}@kline_1m`, `${symbol.toLowerCase()}@kline_5m`];
    const streamsToUnsub = streamsToRemove.filter(s => subscribedStreams.has(s));

    if (streamsToUnsub.length > 0) {
        streamsToUnsub.forEach(s => subscribedStreams.delete(s));
        if (binanceWs && binanceWs.readyState === WebSocket.OPEN) {
            binanceWs.send(JSON.stringify({ method: "UNSUBSCRIBE", params: streamsToUnsub, id: Date.now() }));
            log('BINANCE_WS', `Dynamically unsubscribed from micro streams for ${symbol}.`);
        }
    }
}

// --- Crypto Sector Mapping ---
const CRYPTO_SECTORS = {
    // Layer 1
    'BTC': 'L1', 'ETH': 'L1', 'BNB': 'L1', 'SOL': 'L1', 'ADA': 'L1', 'AVAX': 'L1',
    'DOT': 'L1', 'TRX': 'L1', 'NEAR': 'L1', 'APT': 'L1', 'ALGO': 'L1', 'FTM': 'L1',
    'SUI': 'L1', 'SEI': 'L1', 'ATOM': 'L1', 'ICP': 'L1',
    // Layer 2
    'MATIC': 'L2', 'OP': 'L2', 'ARB': 'L2', 'IMX': 'L2', 'MANTA': 'L2', 'STRK': 'L2',
    // DeFi
    'UNI': 'DeFi', 'LINK': 'DeFi', 'AAVE': 'DeFi', 'LDO': 'DeFi', 'MKR': 'DeFi',
    'CRV': 'DeFi', 'SUSHI': 'DeFi', 'SNX': 'DeFi', 'COMP': 'DeFi', 'RUNE': 'DeFi',
    // Memecoin
    'DOGE': 'Meme', 'SHIB': 'Meme', 'PEPE': 'Meme', 'WIF': 'Meme', 'FLOKI': 'Meme', 'BONK': 'Meme',
    // AI
    'FET': 'AI', 'RNDR': 'AI', 'AGIX': 'AI', 'GRT': 'AI', 'WLD': 'AI',
    // Gaming / Metaverse
    'AXS': 'Gaming', 'SAND': 'Gaming', 'MANA': 'Gaming', 'GALA': 'Gaming',
    // RWA (Real World Assets)
    'ONDO': 'RWA', 'PENDLE': 'RWA',
    // Catch-all
    'XRP': 'Other', 'LTC': 'Other', 'XLM': 'Other', 'ETC': 'Other',
};
const getSymbolSector = (symbol) => {
    const baseAsset = symbol.replace('USDT', '');
    return CRYPTO_SECTORS[baseAsset] || 'Other';
};


// --- Bot State & Core Logic ---
let botState = {
    settings: {},
    balance: 10000,
    activePositions: [],
    tradeHistory: [],
    tradeIdCounter: 1,
    scannerCache: [], // Holds the latest state of all scanned pairs
    isRunning: true,
    tradingMode: 'VIRTUAL', // VIRTUAL, REAL_PAPER, REAL_LIVE
    passwordHash: '',
    recentlyLostSymbols: new Map(), // symbol -> { until: timestamp }
    hotlist: new Set(), // Symbols ready for 1m precision entry
    pendingConfirmation: new Map(), // symbol -> { triggerPrice, triggerTimestamp, slPriceReference, settings }
    priceCache: new Map(), // symbol -> { price: number }
    circuitBreakerStatus: 'NONE', // NONE, WARNING_BTC_DROP, HALTED_BTC_DROP, HALTED_DRAWDOWN, PAUSED_LOSS_STREAK, PAUSED_EXTREME_SENTIMENT
    dayStartBalance: 10000,
    dailyPnl: 0,
    consecutiveLosses: 0,
    consecutiveWins: 0,
    currentTradingDay: new Date().toISOString().split('T')[0],
    fearAndGreed: null,
};

const scanner = new ScannerService(log, KLINE_DATA_DIR);
let scannerInterval = null;

async function runScannerCycle() {
    if (!botState.isRunning) return;
    try {
        const discoveredPairs = await scanner.runScan(botState.settings);
        if (discoveredPairs.length === 0) {
            this.log('WARN', 'No pairs found meeting volume/exclusion criteria.');
            return [];
        }
        const newPairsToHydrate = [];
        const discoveredSymbols = new Set(discoveredPairs.map(p => p.symbol));
        const existingPairsMap = new Map(botState.scannerCache.map(p => [p.symbol, p]));

        // 1. Update existing pairs from the new scan data, and identify brand new pairs.
        for (const discoveredPair of discoveredPairs) {
            const existingPair = existingPairsMap.get(discoveredPair.symbol);
            if (existingPair) {
                // The pair already exists in our cache. We update ONLY the background
                // indicators from the fresh scan, preserving all real-time data
                // (like score, BB width, etc.) that the RealtimeAnalyzer has calculated.
                existingPair.volume = discoveredPair.volume;
                existingPair.price = discoveredPair.price;
                existingPair.price_above_ema50_4h = discoveredPair.price_above_ema50_4h;
                existingPair.rsi_1h = discoveredPair.rsi_1h;
                existingPair.trend_score = discoveredPair.trend_score;
            } else {
                // This is a new pair not seen before. Add it to the main cache
                // and mark it for historical data hydration.
                botState.scannerCache.push(discoveredPair);
                newPairsToHydrate.push(discoveredPair.symbol);
            }
        }

        // 2. Remove pairs that are no longer valid (i.e., they were not in the latest scan results)
        botState.scannerCache = botState.scannerCache.filter(p => discoveredSymbols.has(p.symbol));

        // 3. Asynchronously hydrate the new pairs to get their 15m kline data
        if (newPairsToHydrate.length > 0) {
            log('INFO', `New symbols detected by scanner: [${newPairsToHydrate.join(', ')}]. Hydrating...`);
            await Promise.all(newPairsToHydrate.map(symbol => realtimeAnalyzer.hydrateSymbol(symbol, '15m')));
        }

        // 4. Update WebSocket subscriptions to match the new final list of monitored pairs
        updateBinanceSubscriptions(botState.scannerCache.map(p => p.symbol));
        
    } catch (error) {
        log('ERROR', `Scanner cycle failed: ${error.message}`);
    }
}

const settingProfiles = {
    'Le Sniper': {
        POSITION_SIZE_PCT: 2.0, MAX_OPEN_POSITIONS: 3, REQUIRE_STRONG_BUY: true, USE_RSI_SAFETY_FILTER: true,
        RSI_OVERBOUGHT_THRESHOLD: 65, USE_PARABOLIC_FILTER: true, PARABOLIC_FILTER_PERIOD_MINUTES: 5,
        PARABOLIC_FILTER_THRESHOLD_PCT: 2.5, USE_ATR_STOP_LOSS: true, ATR_MULTIPLIER: 1.5, USE_PARTIAL_TAKE_PROFIT: true,
        PARTIAL_TP_TRIGGER_PCT: 0.8, PARTIAL_TP_SELL_QTY_PCT: 50, USE_AUTO_BREAKEVEN: true, BREAKEVEN_TRIGGER_R: 1.0,
        ADJUST_BREAKEVEN_FOR_FEES: true, TRANSACTION_FEE_PCT: 0.1, USE_ADAPTIVE_TRAILING_STOP: true,
        TRAILING_STOP_TIGHTEN_THRESHOLD_R: 1.5, TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION: 0.5, RISK_REWARD_RATIO: 5.0,
        USE_AGGRESSIVE_ENTRY_LOGIC: false,
        USE_CVD_FILTER: true,
    },
    'Le Scalpeur': {
        POSITION_SIZE_PCT: 3.0, MAX_OPEN_POSITIONS: 5, REQUIRE_STRONG_BUY: false, USE_RSI_SAFETY_FILTER: true,
        RSI_OVERBOUGHT_THRESHOLD: 70, USE_PARABOLIC_FILTER: true, PARABOLIC_FILTER_PERIOD_MINUTES: 5,
        PARABOLIC_FILTER_THRESHOLD_PCT: 3.5, USE_ATR_STOP_LOSS: false, STOP_LOSS_PCT: 2.0, RISK_REWARD_RATIO: 0.75,
        USE_PARTIAL_TAKE_PROFIT: false, USE_AUTO_BREAKEVEN: false, ADJUST_BREAKEVEN_FOR_FEES: false,
        TRANSACTION_FEE_PCT: 0.1, USE_ADAPTIVE_TRAILING_STOP: false, USE_AGGRESSIVE_ENTRY_LOGIC: false,
        USE_CVD_FILTER: false,
    },
    'Le Chasseur de Volatilité': {
        POSITION_SIZE_PCT: 4.0, MAX_OPEN_POSITIONS: 8, REQUIRE_STRONG_BUY: false, USE_RSI_SAFETY_FILTER: false,
        RSI_OVERBOUGHT_THRESHOLD: 80, USE_PARABOLIC_FILTER: false, USE_ATR_STOP_LOSS: true, ATR_MULTIPLIER: 2.0,
        RISK_REWARD_RATIO: 3.0, USE_PARTIAL_TAKE_PROFIT: false, USE_AUTO_BREAKEVEN: true, BREAKEVEN_TRIGGER_R: 2.0,
        ADJUST_BREAKEVEN_FOR_FEES: true, TRANSACTION_FEE_PCT: 0.1, USE_ADAPTIVE_TRAILING_STOP: true,
        TRAILING_STOP_TIGHTEN_THRESHOLD_R: 1.0, TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION: 0.5,
        USE_AGGRESSIVE_ENTRY_LOGIC: true,
        USE_CVD_FILTER: false,
    }
};

// --- Trading Engine ---
const tradingEngine = {
    async evaluateAndOpenTrade(pair, slPriceReference, tradeSettings) {
        if (!botState.isRunning) return false;
        if (botState.circuitBreakerStatus.startsWith('HALTED') || botState.circuitBreakerStatus.startsWith('PAUSED')) {
            log('WARN', `Trade for ${pair.symbol} blocked: Global Circuit Breaker is active (${botState.circuitBreakerStatus}).`);
            return false;
        }
        
        const isIgnition = pair.strategy_type === 'IGNITION';

        // --- Liquidity Filter (Bypassed for Ignition) ---
        if (!isIgnition && tradeSettings.USE_ORDER_BOOK_LIQUIDITY_FILTER) {
            try {
                const depth = await fetch(`https://api.binance.com/api/v3/depth?symbol=${pair.symbol}&limit=100`).then(res => res.json());
                const price = pair.price;
                const range = 0.005; // +/- 0.5%
                const bidsInScope = depth.bids.filter(b => parseFloat(b[0]) >= price * (1 - range));
                const asksInScope = depth.asks.filter(a => parseFloat(a[0]) <= price * (1 + range));
                const totalBidsValue = bidsInScope.reduce((sum, b) => sum + (parseFloat(b[0]) * parseFloat(b[1])), 0);
                const totalAsksValue = asksInScope.reduce((sum, a) => sum + (parseFloat(a[0]) * parseFloat(a[1])), 0);
                const totalLiquidity = totalBidsValue + totalAsksValue;

                if (totalLiquidity < tradeSettings.MIN_ORDER_BOOK_LIQUIDITY_USD) {
                    log('TRADE', `[LIQUIDITY FILTER] Rejected ${pair.symbol}. Liquidity ($${totalLiquidity.toFixed(0)}) is below threshold ($${tradeSettings.MIN_ORDER_BOOK_LIQUIDITY_USD}).`);
                    return false;
                }
            } catch (e) {
                log('ERROR', `[LIQUIDITY FILTER] Failed to fetch order book for ${pair.symbol}: ${e.message}. Skipping trade.`);
                return false;
            }
        }
        
        // --- Sector Correlation Filter (Bypassed for Ignition) ---
        if (!isIgnition && tradeSettings.USE_SECTOR_CORRELATION_FILTER) {
            const newTradeSector = getSymbolSector(pair.symbol);
            if (newTradeSector !== 'Other') {
                const hasOpenTradeInSector = botState.activePositions.some(p => getSymbolSector(p.symbol) === newTradeSector);
                if (hasOpenTradeInSector) {
                    log('TRADE', `[SECTOR FILTER] Rejected ${pair.symbol}. A trade in the '${newTradeSector}' sector is already open.`);
                    return false;
                }
            }
        }

        // --- Correlation Filter (Bypassed for Ignition) ---
        if (!isIgnition) {
            const correlatedTrades = botState.activePositions.filter(p => p.symbol !== 'BTCUSDT' && p.symbol !== 'ETHUSDT').length;
            if (correlatedTrades >= tradeSettings.MAX_CORRELATED_TRADES) {
                log('TRADE', `[CORRELATION FILTER] Skipped trade for ${pair.symbol}. Max correlated trades (${tradeSettings.MAX_CORRELATED_TRADES}) reached.`);
                return false;
            }
        }
        
        // --- RSI Safety Filter (Bypassed for Ignition) ---
        if (!isIgnition && tradeSettings.USE_RSI_SAFETY_FILTER) {
            if (pair.rsi_1h === undefined || pair.rsi_1h === null) {
                log('TRADE', `[RSI FILTER] Skipped trade for ${pair.symbol}. 1h RSI data not available.`);
                return false;
            }
            if (pair.rsi_1h >= tradeSettings.RSI_OVERBOUGHT_THRESHOLD) {
                log('TRADE', `[RSI FILTER] Skipped trade for ${pair.symbol}. 1h RSI (${pair.rsi_1h.toFixed(2)}) is >= threshold (${tradeSettings.RSI_OVERBOUGHT_THRESHOLD}).`);
                return false;
            }
        }

        // --- Parabolic Filter Check (Bypassed for Ignition) ---
        if (!isIgnition && tradeSettings.USE_PARABOLIC_FILTER) {
            const klines1m = realtimeAnalyzer.klineData.get(pair.symbol)?.get('1m');
            if (klines1m && klines1m.length >= tradeSettings.PARABOLIC_FILTER_PERIOD_MINUTES) {
                const checkPeriodKlines = klines1m.slice(-tradeSettings.PARABOLIC_FILTER_PERIOD_MINUTES);
                const startingPrice = checkPeriodKlines[0].open;
                const currentPrice = pair.price;
                const priceIncreasePct = ((currentPrice - startingPrice) / startingPrice) * 100;

                if (priceIncreasePct > tradeSettings.PARABOLIC_FILTER_THRESHOLD_PCT) {
                    log('TRADE', `[PARABOLIC FILTER] Skipped trade for ${pair.symbol}. Price increased by ${priceIncreasePct.toFixed(2)}% in the last ${tradeSettings.PARABOLIC_FILTER_PERIOD_MINUTES} minutes, exceeding threshold of ${tradeSettings.PARABOLIC_FILTER_THRESHOLD_PCT}%.`);
                    return false; // Abort trade
                }
            }
        }
        
        const cooldownInfo = botState.recentlyLostSymbols.get(pair.symbol);
        if (cooldownInfo && Date.now() < cooldownInfo.until) {
            log('TRADE', `Skipping trade for ${pair.symbol} due to recent loss cooldown.`);
            pair.score = 'COOLDOWN'; // Ensure state reflects this
            return false;
        }

        if (botState.activePositions.length >= tradeSettings.MAX_OPEN_POSITIONS) {
            log('TRADE', `Skipping trade for ${pair.symbol}: Max open positions (${tradeSettings.MAX_OPEN_POSITIONS}) reached.`);
            return false;
        }

        if (botState.activePositions.some(p => p.symbol === pair.symbol)) {
            log('TRADE', `Skipping trade for ${pair.symbol}: Position already open.`);
            return false;
        }

        let entryPrice = pair.price;
        let positionSizePct = tradeSettings.POSITION_SIZE_PCT;
        if (tradeSettings.USE_DYNAMIC_POSITION_SIZING && pair.score === 'STRONG BUY') {
            positionSizePct = tradeSettings.STRONG_BUY_POSITION_SIZE_PCT;
        }
        
        let positionSizeUSD = botState.balance * (positionSizePct / 100);
        
        if (botState.circuitBreakerStatus === 'WARNING_BTC_DROP') {
            positionSizeUSD /= 2;
            log('WARN', `[CIRCUIT BREAKER] WARNING ACTIVE. Reducing position size for ${pair.symbol} to $${positionSizeUSD.toFixed(2)}.`);
        }

        const target_quantity = positionSizeUSD / entryPrice;

        const scalingInPercents = (tradeSettings.SCALING_IN_CONFIG || "").split(',').map(p => parseFloat(p.trim())).filter(p => !isNaN(p) && p > 0);
        let useScalingIn = !isIgnition && scalingInPercents.length > 0;
        
        let initial_quantity = useScalingIn ? (target_quantity * (scalingInPercents[0] / 100)) : target_quantity;
        let initial_cost = initial_quantity * entryPrice;

        const rules = symbolRules.get(pair.symbol);
        const minNotionalValue = rules ? rules.minNotional : 5.0; // Use a safe default of 5 USDT

        // --- MIN_NOTIONAL CHECK & ADJUSTMENT ---
        if (botState.tradingMode === 'REAL_LIVE' && initial_cost < minNotionalValue) {
            log('WARN', `[MIN_NOTIONAL] Initial order size for ${pair.symbol} ($${initial_cost.toFixed(2)}) is below minimum ($${minNotionalValue}). Adjusting...`);
            
            const fullPositionCost = target_quantity * entryPrice;

            if (fullPositionCost < minNotionalValue) {
                log('ERROR', `[MIN_NOTIONAL] Aborting trade for ${pair.symbol}. Even full position size ($${fullPositionCost.toFixed(2)}) is below minimum notional value ($${minNotionalValue}). Consider increasing POSITION_SIZE_PCT.`);
                return false;
            }
            
            log('WARN', `[MIN_NOTIONAL] Disabling scaling-in for this trade to meet minimum notional. Using full position size: $${fullPositionCost.toFixed(2)}.`);
            initial_quantity = target_quantity;
            initial_cost = fullPositionCost;
            useScalingIn = false; // Override for this trade
        }
        
        // --- REAL TRADE EXECUTION ---
        if (botState.tradingMode === 'REAL_LIVE') {
            if (!binanceApiClient) {
                log('ERROR', `[REAL_LIVE] Cannot open trade for ${pair.symbol}. Binance API client not initialized.`);
                return false;
            }
            try {
                const formattedQty = formatQuantity(pair.symbol, initial_quantity);
                log('TRADE', `>>> [REAL_LIVE] FIRING TRADE <<< Attempting to BUY ${formattedQty} ${pair.symbol} at MARKET price.`);
                const orderResult = await binanceApiClient.createOrder(pair.symbol, 'BUY', 'MARKET', formattedQty);
                log('BINANCE_API', `[REAL_LIVE] Order successful for ${pair.symbol}. Order ID: ${orderResult.orderId}`);
                
                // === BUG FIX: Use actual fill price instead of cached price ===
                const executedQty = parseFloat(orderResult.executedQty);
                if (executedQty > 0) {
                    const cummulativeQuoteQty = parseFloat(orderResult.cummulativeQuoteQty);
                    entryPrice = cummulativeQuoteQty / executedQty;
                    log('TRADE', `[REAL_LIVE] Actual average entry price for ${pair.symbol} is $${entryPrice.toFixed(4)}.`);
                } else {
                    log('ERROR', `[REAL_LIVE] Order for ${pair.symbol} was successful but executed quantity is zero. Aborting trade.`);
                    return false;
                }

            } catch (error) {
                log('ERROR', `[REAL_LIVE] FAILED to place order for ${pair.symbol}. Error: ${error.message}. Aborting trade.`);
                return false;
            }
        }

        let stopLoss;
        if (isIgnition) {
            // For Ignition, SL is the low of the trigger candle. Flash Trailing SL will manage it from there.
            stopLoss = slPriceReference;
        } else if (tradeSettings.USE_ATR_STOP_LOSS && pair.atr_15m) {
            stopLoss = entryPrice - (pair.atr_15m * tradeSettings.ATR_MULTIPLIER);
        } else {
            stopLoss = slPriceReference * (1 - tradeSettings.STOP_LOSS_PCT / 100);
        }

        const riskPerUnit = entryPrice - stopLoss;
        if (riskPerUnit <= 0) {
            log('ERROR', `Calculated risk is zero or negative for ${pair.symbol}. SL: ${stopLoss}, Entry: ${entryPrice}. Aborting trade.`);
            return false;
        }
        
        const takeProfit = entryPrice + (riskPerUnit * tradeSettings.RISK_REWARD_RATIO);
        
        const newTrade = {
            id: botState.tradeIdCounter++,
            mode: botState.tradingMode,
            symbol: pair.symbol,
            side: 'BUY',
            entry_price: entryPrice,
            average_entry_price: entryPrice,
            quantity: initial_quantity,
            target_quantity: target_quantity,
            total_cost_usd: initial_cost,
            stop_loss: stopLoss,
            initial_stop_loss: stopLoss, // Store initial SL for R calculation
            take_profit: takeProfit,
            highest_price_since_entry: entryPrice,
            entry_time: new Date().toISOString(),
            status: 'FILLED', // Assume fill for both virtual and real (since it's a market order)
            entry_snapshot: { ...pair },
            is_at_breakeven: false,
            partial_tp_hit: false,
            realized_pnl: 0,
            trailing_stop_tightened: false,
            is_scaling_in: useScalingIn && scalingInPercents.length > 1,
            current_entry_count: 1,
            total_entries: useScalingIn ? scalingInPercents.length : 1,
            scaling_in_percents: scalingInPercents,
            strategy_type: pair.strategy_type,
            management_settings: {
                USE_AUTO_BREAKEVEN: tradeSettings.USE_AUTO_BREAKEVEN,
                BREAKEVEN_TRIGGER_R: tradeSettings.BREAKEVEN_TRIGGER_R,
                ADJUST_BREAKEVEN_FOR_FEES: tradeSettings.ADJUST_BREAKEVEN_FOR_FEES,
                TRANSACTION_FEE_PCT: tradeSettings.TRANSACTION_FEE_PCT,
                USE_ADAPTIVE_TRAILING_STOP: tradeSettings.USE_ADAPTIVE_TRAILING_STOP,
                ATR_MULTIPLIER: tradeSettings.ATR_MULTIPLIER,
                TRAILING_STOP_TIGHTEN_THRESHOLD_R: tradeSettings.TRAILING_STOP_TIGHTEN_THRESHOLD_R,
                TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION: tradeSettings.TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION,
                USE_FLASH_TRAILING_STOP: tradeSettings.USE_FLASH_TRAILING_STOP,
                FLASH_TRAILING_STOP_PCT: tradeSettings.FLASH_TRAILING_STOP_PCT,
                USE_PARTIAL_TAKE_PROFIT: tradeSettings.USE_PARTIAL_TAKE_PROFIT,
                PARTIAL_TP_TRIGGER_PCT: tradeSettings.PARTIAL_TP_TRIGGER_PCT,
                PARTIAL_TP_SELL_QTY_PCT: tradeSettings.PARTIAL_TP_SELL_QTY_PCT,
            }
        };

        log('TRADE', `>>> TRADE OPENED (STRATEGY: ${newTrade.strategy_type || 'N/A'}, ENTRY 1/${newTrade.total_entries}) <<< Opening ${botState.tradingMode} trade for ${pair.symbol}: Qty=${initial_quantity.toFixed(4)}, Entry=$${entryPrice}`);
        
        botState.activePositions.push(newTrade);
        if (botState.tradingMode === 'VIRTUAL') {
            botState.balance -= initial_cost;
        }
        
        saveData('state');
        broadcast({ type: 'POSITIONS_UPDATED' });
        return true;
    },

    async scaleInPosition(position, newPrice, tradeSettings) {
        if (!position.scaling_in_percents || position.current_entry_count >= position.total_entries) return;
        
        const nextEntryPercent = position.scaling_in_percents[position.current_entry_count];
        const chunkQty = position.target_quantity * (nextEntryPercent / 100);

        if (botState.tradingMode === 'REAL_LIVE') {
            if (!binanceApiClient) {
                log('ERROR', `[REAL_LIVE] Cannot scale in for ${position.symbol}. Binance API client not initialized.`);
                return;
            }
            try {
                const formattedQty = formatQuantity(position.symbol, chunkQty);
                 log('TRADE', `[REAL_LIVE] Scaling In: Attempting to BUY ${formattedQty} ${position.symbol} at MARKET price.`);
                const orderResult = await binanceApiClient.createOrder(position.symbol, 'BUY', 'MARKET', formattedQty);
                log('BINANCE_API', `[REAL_LIVE] Scale-in order successful for ${position.symbol}. Order ID: ${orderResult.orderId}`);
            } catch (error) {
                log('ERROR', `[REAL_LIVE] FAILED to scale in for ${position.symbol}. Error: ${error.message}. Stopping scale-in for this trade.`);
                position.is_scaling_in = false;
                return;
            }
        }
        
        const chunkCost = chunkQty * newPrice;

        if (botState.tradingMode === 'VIRTUAL' && botState.balance < chunkCost) {
            log('WARN', `[SCALING IN] Insufficient virtual balance to scale in for ${position.symbol}.`);
            position.is_scaling_in = false; // Stop trying to scale in
            return;
        }

        const newTotalCost = position.total_cost_usd + chunkCost;
        const newTotalQty = position.quantity + chunkQty;

        position.average_entry_price = newTotalCost / newTotalQty;
        position.quantity = newTotalQty;
        position.total_cost_usd = newTotalCost;
        position.current_entry_count++;
        
        if (botState.tradingMode === 'VIRTUAL') {
            botState.balance -= chunkCost;
        }

        // Recalculate Take Profit based on new average entry price
        const riskPerUnit = position.average_entry_price - position.initial_stop_loss;
        position.take_profit = position.average_entry_price + (riskPerUnit * tradeSettings.RISK_REWARD_RATIO);

        log('TRADE', `[SCALING IN] Entry ${position.current_entry_count}/${position.total_entries} for ${position.symbol} at $${newPrice}. New Avg Price: $${position.average_entry_price.toFixed(4)}`);

        if (position.current_entry_count >= position.total_entries) {
            position.is_scaling_in = false;
            log('TRADE', `[SCALING IN] Final entry for ${position.symbol} complete.`);
        }

        saveData('state');
        broadcast({ type: 'POSITIONS_UPDATED' });
    },

    monitorAndManagePositions() {
        if (!botState.isRunning) return;

        // Check for timed-out pending confirmations
        const now = Date.now();
        const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
        for (const [symbol, pending] of botState.pendingConfirmation.entries()) {
            if (now - pending.triggerTimestamp > TIMEOUT_MS) {
                log('TRADE', `[MTF] TIMEOUT: Pending signal for ${symbol} expired.`);
                botState.pendingConfirmation.delete(symbol);
                const pair = botState.scannerCache.find(p => p.symbol === symbol);
                if (pair) {
                    pair.score = 'HOLD';
                    broadcast({ type: 'SCANNER_UPDATE', payload: pair });
                }
            }
        }


        const positionsToClose = [];
        botState.activePositions.forEach(pos => {
            const priceData = botState.priceCache.get(pos.symbol);
            if (!priceData) {
                log('WARN', `No price data available for active position ${pos.symbol}. Skipping management check.`);
                return;
            }

            // Use trade-specific settings with a fallback to global settings for safety/backwards compatibility
            const s = pos.management_settings || botState.settings;

            const currentPrice = priceData.price;
            if (currentPrice > pos.highest_price_since_entry) {
                pos.highest_price_since_entry = currentPrice;
            }

            if (currentPrice <= pos.stop_loss) {
                positionsToClose.push({ trade: pos, exitPrice: pos.stop_loss, reason: 'Stop Loss' });
                return;
            }

            if (currentPrice >= pos.take_profit) {
                positionsToClose.push({ trade: pos, exitPrice: pos.take_profit, reason: 'Take Profit' });
                return;
            }
            
            // --- R-Multiple Calculation ---
            let currentR = 0;
            if (pos.initial_stop_loss) {
                const initialRiskPerUnit = pos.average_entry_price - pos.initial_stop_loss;
                if (initialRiskPerUnit > 0) {
                    const currentProfitPerUnit = currentPrice - pos.average_entry_price;
                    currentR = currentProfitPerUnit / initialRiskPerUnit;
                }
            }

            // --- Partial Take Profit (remains Pct-based as per current implementation) ---
            const pnlPct = ((currentPrice - pos.average_entry_price) / pos.average_entry_price) * 100;
            if (s.USE_PARTIAL_TAKE_PROFIT && !pos.partial_tp_hit && pnlPct >= s.PARTIAL_TP_TRIGGER_PCT) {
                this.executePartialSell(pos, currentPrice, s);
            }

            // --- R-Based Auto Break-even ---
            if (s.USE_AUTO_BREAKEVEN && !pos.is_at_breakeven && currentR >= s.BREAKEVEN_TRIGGER_R) {
                let newStopLoss = pos.average_entry_price;
                if (s.ADJUST_BREAKEVEN_FOR_FEES && s.TRANSACTION_FEE_PCT > 0) {
                    newStopLoss *= (1 + (s.TRANSACTION_FEE_PCT / 100) * 2);
                }
                pos.stop_loss = newStopLoss;
                pos.is_at_breakeven = true;
                log('TRADE', `[${pos.symbol}] Profit at ${currentR.toFixed(2)}R. Stop Loss moved to Break-even at $${newStopLoss.toFixed(4)}.`);
            }
            
            // --- Flash Trailing Stop for Ignition Trades (Overrides other trailing logic) ---
            if (pos.strategy_type === 'IGNITION' && s.USE_FLASH_TRAILING_STOP) {
                const newTrailingSL = pos.highest_price_since_entry * (1 - s.FLASH_TRAILING_STOP_PCT / 100);
                if (newTrailingSL > pos.stop_loss) {
                    pos.stop_loss = newTrailingSL;
                }
                return; // IMPORTANT: Skip other trailing logic if flash stop is active
            }

            // --- R-Based Adaptive Trailing Stop ---
            // This logic activates AFTER break-even is hit.
            if (s.USE_ADAPTIVE_TRAILING_STOP && pos.is_at_breakeven && pos.entry_snapshot?.atr_15m) {
                let atrMultiplier = s.ATR_MULTIPLIER;
                
                // Check if we should tighten the multiplier
                if (currentR >= s.TRAILING_STOP_TIGHTEN_THRESHOLD_R) {
                    if (!pos.trailing_stop_tightened) {
                        atrMultiplier -= s.TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION;
                        pos.trailing_stop_tightened = true; // Mark as tightened
                        log('TRADE', `[${pos.symbol}] Adaptive SL: Profit > ${s.TRAILING_STOP_TIGHTEN_THRESHOLD_R}R. Tightening ATR multiplier to ${atrMultiplier.toFixed(2)}.`);
                    } else {
                        // It's already tightened, so just use the reduced multiplier
                         atrMultiplier -= s.TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION;
                    }
                }
                
                const newTrailingSL = pos.highest_price_since_entry - (pos.entry_snapshot.atr_15m * atrMultiplier);
                
                if (newTrailingSL > pos.stop_loss) {
                    pos.stop_loss = newTrailingSL;
                }
            }
        });

        if (positionsToClose.length > 0) {
            positionsToClose.forEach(async ({ trade, exitPrice, reason }) => {
                await this.closeTrade(trade.id, exitPrice, reason);
            });
            saveData('state');
            broadcast({ type: 'POSITIONS_UPDATED' });
        }
    },

    async closeTrade(tradeId, exitPrice, reason = 'Manual Close') {
        const tradeIndex = botState.activePositions.findIndex(t => t.id === tradeId);
        if (tradeIndex === -1) {
            log('WARN', `Could not find trade with ID ${tradeId} to close.`);
            return null;
        }

        const trade = botState.activePositions[tradeIndex];

        // --- REAL TRADE EXECUTION ---
        if (trade.mode === 'REAL_LIVE') {
            if (!binanceApiClient) {
                log('ERROR', `[REAL_LIVE] Cannot close trade for ${trade.symbol}. Binance API client not initialized.`);
                // CRITICAL: DO NOT close the position internally if the API client is down.
                return null;
            }
            try {
                const formattedQty = formatQuantity(trade.symbol, trade.quantity);
                log('TRADE', `>>> [REAL_LIVE] CLOSING TRADE <<< Attempting to SELL ${formattedQty} ${trade.symbol} at MARKET price.`);
                const orderResult = await binanceApiClient.createOrder(trade.symbol, 'SELL', 'MARKET', formattedQty);
                log('BINANCE_API', `[REAL_LIVE] Close order successful for ${trade.symbol}. Order ID: ${orderResult.orderId}`);
                
                // === BUG FIX: Use actual average fill price instead of first fill ===
                const executedQty = parseFloat(orderResult.executedQty);
                if (executedQty > 0) {
                    const cummulativeQuoteQty = parseFloat(orderResult.cummulativeQuoteQty);
                    exitPrice = cummulativeQuoteQty / executedQty;
                    log('TRADE', `[REAL_LIVE] Actual average exit price for ${trade.symbol} is $${exitPrice.toFixed(4)}.`);
                } else {
                    log('ERROR', `[REAL_LIVE] Close order for ${trade.symbol} was successful but executed quantity is zero. Manual check required.`);
                }

            } catch (error) {
                 log('ERROR', `[REAL_LIVE] FAILED to place closing order for ${trade.symbol}. Error: ${error.message}. THE POSITION REMAINS OPEN ON BINANCE AND IN THE BOT. MANUAL INTERVENTION REQUIRED.`);
                // CRITICAL: Do not proceed with internal closing logic if the real order fails.
                return null;
            }
        }
        
        // --- Internal State Update (only after successful real close, or for virtual modes) ---
        botState.activePositions.splice(tradeIndex, 1);
        
        trade.exit_price = exitPrice;
        trade.exit_time = new Date().toISOString();
        trade.status = 'CLOSED';

        const exitValue = exitPrice * trade.quantity;
        const pnl = (trade.realized_pnl || 0) + exitValue - trade.total_cost_usd;
        
        const initialFullPositionValue = trade.average_entry_price * trade.target_quantity;

        trade.pnl = pnl;
        trade.pnl_pct = (pnl / initialFullPositionValue) * 100;

        if (trade.mode === 'VIRTUAL') {
            botState.balance += trade.total_cost_usd + pnl;
        } else {
             // For REAL modes, the balance should be re-fetched from Binance periodically,
             // but we can update it optimistically for immediate UI feedback.
             // A full balance sync should happen after a trade.
             botState.balance += pnl; // Approximate update
        }
        
        // --- Daily Stats Update ---
        const today = new Date().toISOString().split('T')[0];
        if (today !== botState.currentTradingDay) {
            log('INFO', `New trading day. Resetting daily stats. Previous day PnL: $${botState.dailyPnl.toFixed(2)}`);
            botState.dailyPnl = 0;
            botState.consecutiveLosses = 0;
            botState.consecutiveWins = 0;
            botState.currentTradingDay = today;
            botState.dayStartBalance = botState.balance; // Set new day's starting balance
            
            if (botState.circuitBreakerStatus === 'HALTED_DRAWDOWN') {
                botState.circuitBreakerStatus = 'NONE';
                broadcast({ type: 'CIRCUIT_BREAKER_UPDATE', payload: { status: 'NONE' } });
            }
        }

        botState.dailyPnl += pnl;

        if (pnl < 0) {
            botState.consecutiveLosses++;
            botState.consecutiveWins = 0;
        } else if (pnl > 0) {
            botState.consecutiveWins++;
            botState.consecutiveLosses = 0;
            if (botState.circuitBreakerStatus === 'PAUSED_LOSS_STREAK') {
                log('INFO', 'Winning trade breaks loss streak. Resuming trading.');
                botState.circuitBreakerStatus = 'NONE';
            }
        }
        
        checkGlobalSafetyRules();
        
        botState.tradeHistory.push(trade);
        
        if (pnl < 0 && botState.settings.LOSS_COOLDOWN_HOURS > 0) {
            const cooldownUntil = Date.now() + botState.settings.LOSS_COOLDOWN_HOURS * 60 * 60 * 1000;
            botState.recentlyLostSymbols.set(trade.symbol, { until: cooldownUntil });
            log('TRADE', `[${trade.symbol}] placed on cooldown until ${new Date(cooldownUntil).toLocaleString()}`);
        }
        
        log('TRADE', `<<< TRADE CLOSED >>> [${reason}] Closed ${trade.symbol} at $${exitPrice.toFixed(4)}. PnL: $${pnl.toFixed(2)} (${trade.pnl_pct.toFixed(2)}%)`);
        return trade;
    },
    
    executePartialSell(position, currentPrice, settings) {
        // Note: Real partial sells are not implemented for simplicity.
        // This logic only applies to VIRTUAL mode.
        if (position.mode !== 'VIRTUAL') return;

        const s = settings;
        const initialQty = position.target_quantity;
        const sellQty = initialQty * (s.PARTIAL_TP_SELL_QTY_PCT / 100);
        const pnlFromSale = (currentPrice - position.average_entry_price) * sellQty;

        position.quantity -= sellQty;
        position.total_cost_usd -= position.average_entry_price * sellQty;
        position.realized_pnl = (position.realized_pnl || 0) + pnlFromSale;
        position.partial_tp_hit = true;
        
        log('TRADE', `[PARTIAL TP] Sold ${s.PARTIAL_TP_SELL_QTY_PCT}% of ${position.symbol} at $${currentPrice}. Realized PnL: $${pnlFromSale.toFixed(2)}`);
    }
};

const checkGlobalSafetyRules = () => {
    const s = botState.settings;
    let newStatus = botState.circuitBreakerStatus;
    let statusReason = "";

    // If already halted for a major reason, don't change it to a lesser warning.
    if (newStatus === 'HALTED_BTC_DROP' || newStatus === 'HALTED_DRAWDOWN') {
        return; 
    }

    // Rule 1: Daily Drawdown Limit (Highest Priority Halt)
    const drawdownLimitUSD = (botState.dayStartBalance * (s.DAILY_DRAWDOWN_LIMIT_PCT / 100));
    if (botState.dailyPnl < 0 && Math.abs(botState.dailyPnl) >= drawdownLimitUSD) {
        newStatus = 'HALTED_DRAWDOWN';
        statusReason = `Daily drawdown limit of -$${drawdownLimitUSD.toFixed(2)} reached. Trading halted for the day.`;
    }
    // Rule 2: Consecutive Loss Limit (Pause)
    else if (botState.consecutiveLosses >= s.CONSECUTIVE_LOSS_LIMIT) {
        newStatus = 'PAUSED_LOSS_STREAK';
        statusReason = `${s.CONSECUTIVE_LOSS_LIMIT} consecutive losses reached. Trading is paused.`;
    }
    // Rule 3: Extreme Market Sentiment (Pause)
    else if (s.USE_FEAR_AND_GREED_FILTER && botState.fearAndGreed) {
        if (botState.fearAndGreed.value <= 15 || botState.fearAndGreed.value >= 85) {
            newStatus = 'PAUSED_EXTREME_SENTIMENT';
            statusReason = `Extreme market sentiment detected (F&G: ${botState.fearAndGreed.value}). Trading paused.`;
        } else if (newStatus === 'PAUSED_EXTREME_SENTIMENT') {
            newStatus = 'NONE';
            statusReason = 'Market sentiment has returned to normal levels.';
        }
    }
    // Rule 4: BTC Price Drop (Existing logic)
    // Only check this if no other halt/pause is active yet from this check
    else {
        const btcKlines1m = realtimeAnalyzer.klineData.get('BTCUSDT')?.get('1m');
        if (btcKlines1m && btcKlines1m.length >= 5) {
            const periodKlines = btcKlines1m.slice(-5);
            const startPrice = periodKlines[0].open;
            const currentPrice = periodKlines[periodKlines.length - 1].close;
            const dropPct = ((startPrice - currentPrice) / startPrice) * 100;

            if (dropPct >= s.CIRCUIT_BREAKER_HALT_THRESHOLD_PCT) {
                newStatus = 'HALTED_BTC_DROP';
                statusReason = `BTC drop of ${dropPct.toFixed(2)}% exceeded HALT threshold.`;
            } else if (dropPct >= s.CIRCUIT_BREAKER_WARN_THRESHOLD_PCT) {
                newStatus = 'WARNING_BTC_DROP';
                 statusReason = `BTC drop of ${dropPct.toFixed(2)}% exceeded WARN threshold.`;
            } else {
                // If we were in a BTC warning and now we are not, reset to NONE.
                if (botState.circuitBreakerStatus === 'WARNING_BTC_DROP') {
                    newStatus = 'NONE';
                    statusReason = 'BTC price stabilized.';
                }
            }
        }
    }
    
    if (newStatus !== botState.circuitBreakerStatus) {
        botState.circuitBreakerStatus = newStatus;
        log('WARN', `!!! CIRCUIT BREAKER STATUS CHANGE: ${newStatus} !!! Reason: ${statusReason}`);
        broadcast({ type: 'CIRCUIT_BREAKER_UPDATE', payload: { status: newStatus } });

        if (newStatus === 'HALTED_BTC_DROP') {
            const positionsToClose = [...botState.activePositions];
            if (positionsToClose.length > 0) {
                log('ERROR', `Closing ${positionsToClose.length} open positions due to Circuit Breaker HALT (BTC DROP).`);
                positionsToClose.forEach(async pos => {
                    const priceData = botState.priceCache.get(pos.symbol);
                    const exitPrice = priceData ? priceData.price : pos.entry_price;
                    await tradingEngine.closeTrade(pos.id, exitPrice, 'Circuit Breaker');
                });
                saveData('state');
                broadcast({ type: 'POSITIONS_UPDATED' });
            }
        }
    }
};

const fetchFearAndGreedIndex = async () => {
    try {
        const response = await fetch('https://api.alternative.me/fng/?limit=1');
        if (!response.ok) {
            throw new Error(`API returned status ${response.status}`);
        }
        const data = await response.json();
        if (data && data.data && data.data.length > 0) {
            const fng = data.data[0];
            const fngData = {
                value: parseInt(fng.value, 10),
                classification: fng.value_classification,
            };
            botState.fearAndGreed = fngData;
            broadcast({ type: 'FEAR_AND_GREED_UPDATE', payload: fngData });
            // After updating, check the rules
            checkGlobalSafetyRules();
        }
    } catch (error) {
        log('ERROR', `Failed to fetch Fear & Greed Index: ${error.message}`);
    }
};

// --- Main Application Loop ---
const startBot = async () => {
    if (scannerInterval) clearInterval(scannerInterval);
    
    if (botState.settings.BINANCE_API_KEY && botState.settings.BINANCE_SECRET_KEY) {
        binanceApiClient = new BinanceApiClient(botState.settings.BINANCE_API_KEY, botState.settings.BINANCE_SECRET_KEY, log);
        try {
            const exchangeInfo = await binanceApiClient.getExchangeInfo();
            exchangeInfo.symbols.forEach(s => {
                const lotSizeFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
                const minNotionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
                
                symbolRules.set(s.symbol, {
                    stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : 1,
                    minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.minNotional) : 5.0
                });
            });
            log('INFO', `Cached trading rules for ${symbolRules.size} symbols.`);
        } catch (e) {
            log('ERROR', 'Failed to initialize Binance API client with exchange info. Real trading will fail.');
        }
    }

    // Initial scan, then set interval
    runScannerCycle(); 
    scannerInterval = setInterval(runScannerCycle, botState.settings.SCANNER_DISCOVERY_INTERVAL_SECONDS * 1000);
    
    setInterval(() => {
        if (botState.isRunning) {
            tradingEngine.monitorAndManagePositions();
        }
    }, 1000); // Manage positions every second for high-frequency checks
    
    // Fetch Fear & Greed index periodically
    fetchFearAndGreedIndex();
    setInterval(fetchFearAndGreedIndex, 15 * 60 * 1000); // Every 15 minutes

    connectToBinanceStreams();
    log('INFO', 'Bot started. Initializing scanner and position manager...');
};

// --- API Endpoints ---
const requireAuth = (req, res, next) => {
    if (req.session && req.session.isAuthenticated) {
        next();
    } else {
        res.status(401).json({ message: 'Unauthorized' });
    }
};

// --- AUTH ---
app.post('/api/login', async (req, res) => {
    const { password } = req.body;
    try {
        const isValid = await verifyPassword(password, botState.passwordHash);
        if (isValid) {
            req.session.isAuthenticated = true;
            res.json({ success: true, message: 'Login successful.' });
        } else {
            res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }
    } catch (error) {
        log('ERROR', `Login attempt failed: ${error.message}`);
        res.status(500).json({ success: false, message: 'Internal server error during login.' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({ message: 'Could not log out.' });
        }
        res.clearCookie('connect.sid');
        res.status(204).send();
    });
});

app.get('/api/check-session', (req, res) => {
    if (req.session && req.session.isAuthenticated) {
        res.json({ isAuthenticated: true });
    } else {
        res.json({ isAuthenticated: false });
    }
});

app.post('/api/change-password', requireAuth, async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long.' });
    }
    try {
        botState.passwordHash = await hashPassword(newPassword);
        await saveData('auth');
        log('INFO', 'User password has been successfully updated.');
        res.json({ success: true, message: 'Password updated successfully.' });
    } catch (error) {
        log('ERROR', `Failed to update password: ${error.message}`);
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});


// --- SETTINGS ---
app.get('/api/settings', requireAuth, (req, res) => {
    res.json(botState.settings);
});

app.post('/api/settings', requireAuth, async (req, res) => {
    const oldSettings = { ...botState.settings };
    
    // Update settings in memory
    botState.settings = { ...botState.settings, ...req.body };
    
    // If virtual balance setting is changed while in VIRTUAL mode, update the current balance.
    if (botState.tradingMode === 'VIRTUAL' && botState.settings.INITIAL_VIRTUAL_BALANCE !== oldSettings.INITIAL_VIRTUAL_BALANCE) {
        botState.balance = botState.settings.INITIAL_VIRTUAL_BALANCE;
        log('INFO', `Virtual balance was adjusted to match new setting: $${botState.balance}`);
        await saveData('state'); // Persist the new balance
        // Trigger a refresh on the frontend to show the new balance.
        broadcast({ type: 'POSITIONS_UPDATED' });
    }

    await saveData('settings');
    realtimeAnalyzer.updateSettings(botState.settings);
    
    // If API keys change, re-initialize the client
    if (botState.settings.BINANCE_API_KEY !== oldSettings.BINANCE_API_KEY || botState.settings.BINANCE_SECRET_KEY !== oldSettings.BINANCE_SECRET_KEY) {
        log('INFO', 'Binance API keys updated. Re-initializing API client.');
        if (botState.settings.BINANCE_API_KEY && botState.settings.BINANCE_SECRET_KEY) {
            binanceApiClient = new BinanceApiClient(botState.settings.BINANCE_API_KEY, botState.settings.BINANCE_SECRET_KEY, log);
        } else {
            binanceApiClient = null;
        }
    }
    
    // Restart scanner interval only if the timing changed
    if (botState.settings.SCANNER_DISCOVERY_INTERVAL_SECONDS !== oldSettings.SCANNER_DISCOVERY_INTERVAL_SECONDS) {
        log('INFO', `Scanner interval updated to ${botState.settings.SCANNER_DISCOVERY_INTERVAL_SECONDS} seconds.`);
        if (scannerInterval) clearInterval(scannerInterval);
        scannerInterval = setInterval(runScannerCycle, botState.settings.SCANNER_DISCOVERY_INTERVAL_SECONDS * 1000);
    }
    
    res.json({ success: true });
});

// --- DATA & STATUS ---
app.get('/api/status', requireAuth, (req, res) => {
    res.json({
        mode: botState.tradingMode,
        balance: botState.balance,
        positions: botState.activePositions.length,
        monitored_pairs: botState.scannerCache.length,
        top_pairs: botState.scannerCache
            .sort((a, b) => (b.score_value || 0) - (a.score_value || 0))
            .slice(0, 15)
            .map(p => p.symbol),
        max_open_positions: botState.settings.MAX_OPEN_POSITIONS
    });
});

app.get('/api/positions', requireAuth, (req, res) => {
    // Augment positions with current price from scanner cache for frontend display
    const augmentedPositions = botState.activePositions.map(pos => {
        const priceData = botState.priceCache.get(pos.symbol);
        const currentPrice = priceData ? priceData.price : pos.average_entry_price;
        const current_value = currentPrice * pos.quantity;
        const pnl = (pos.realized_pnl || 0) + current_value - pos.total_cost_usd;
        
        const initialFullPositionValue = pos.average_entry_price * pos.target_quantity;
        const pnl_pct = initialFullPositionValue > 0 ? (pnl / initialFullPositionValue) * 100 : 0;

        return {
            ...pos,
            current_price: currentPrice,
            pnl: pnl,
            pnl_pct: pnl_pct,
        };
    });
    res.json(augmentedPositions);
});

app.get('/api/history', requireAuth, (req, res) => {
    res.json(botState.tradeHistory);
});

app.get('/api/performance-stats', requireAuth, (req, res) => {
    const total_trades = botState.tradeHistory.length;
    const winning_trades = botState.tradeHistory.filter(t => (t.pnl || 0) > 0).length;
    const losing_trades = botState.tradeHistory.filter(t => (t.pnl || 0) < 0).length;
    const total_pnl = botState.tradeHistory.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const win_rate = total_trades > 0 ? (winning_trades / total_trades) * 100 : 0;
    
    const pnlPcts = botState.tradeHistory.map(t => t.pnl_pct).filter(p => p !== undefined && p !== null);
    const avg_pnl_pct = pnlPcts.length > 0 ? pnlPcts.reduce((a, b) => a + b, 0) / pnlPcts.length : 0;

    res.json({ total_trades, winning_trades, losing_trades, total_pnl, win_rate, avg_pnl_pct });
});

app.get('/api/scanner', requireAuth, (req, res) => {
    res.json(botState.scannerCache);
});


// --- ACTIONS ---
app.post('/api/open-trade', requireAuth, (req, res) => {
    // Manual trade opening logic can be added here if needed
    res.status(501).json({ message: 'Manual trade opening not implemented.' });
});

app.post('/api/close-trade/:id', requireAuth, async (req, res) => {
    const tradeId = parseInt(req.params.id, 10);
    const trade = botState.activePositions.find(t => t.id === tradeId);
    if (!trade) return res.status(404).json({ message: 'Trade not found.' });

    const priceData = botState.priceCache.get(trade.symbol);
    const exitPrice = priceData ? priceData.price : trade.average_entry_price;

    const closedTrade = await tradingEngine.closeTrade(tradeId, exitPrice, 'Manual Close');
    if (closedTrade) {
        saveData('state');
        broadcast({ type: 'POSITIONS_UPDATED' });
        res.json(closedTrade);
    } else {
        res.status(500).json({ message: 'Failed to close trade on exchange. Position remains open.' });
    }
});

app.post('/api/clear-data', requireAuth, async (req, res) => {
    log('WARN', 'User initiated data clear. Resetting all trade history and balance.');
    botState.balance = botState.settings.INITIAL_VIRTUAL_BALANCE;
    botState.activePositions = [];
    botState.tradeHistory = [];
    botState.tradeIdCounter = 1;
    await saveData('state');
    broadcast({ type: 'POSITIONS_UPDATED' });
    res.json({ success: true });
});

// --- CONNECTION TESTS ---
app.post('/api/test-connection', requireAuth, async (req, res) => {
    const { apiKey, secretKey } = req.body;
    if (!apiKey || !secretKey) {
        return res.status(400).json({ success: false, message: "API Key and Secret Key are required." });
    }
    const tempApiClient = new BinanceApiClient(apiKey, secretKey, log);
    try {
        await tempApiClient.getAccountInfo();
        res.json({ success: true, message: 'Connexion à Binance et validation des clés réussies !' });
    } catch (error) {
        res.status(500).json({ success: false, message: `Échec de la connexion à Binance : ${error.message}` });
    }
});


// --- BOT CONTROL ---
app.get('/api/bot/status', requireAuth, (req, res) => {
    res.json({ isRunning: botState.isRunning });
});
app.post('/api/bot/start', requireAuth, async (req, res) => {
    botState.isRunning = true;
    await saveData('state');
    log('INFO', 'Bot has been started via API.');
    res.json({ success: true });
});
app.post('/api/bot/stop', requireAuth, async (req, res) => {
    botState.isRunning = false;
    await saveData('state');
    log('INFO', 'Bot has been stopped via API.');
    res.json({ success: true });
});
app.get('/api/mode', requireAuth, (req, res) => {
    res.json({ mode: botState.tradingMode });
});
app.post('/api/mode', requireAuth, async (req, res) => {
    const { mode } = req.body;
    if (['VIRTUAL', 'REAL_PAPER', 'REAL_LIVE'].includes(mode)) {
        botState.tradingMode = mode;
        if (mode === 'VIRTUAL') {
            botState.balance = botState.settings.INITIAL_VIRTUAL_BALANCE; // Reset to virtual balance
            log('INFO', 'Switched to VIRTUAL mode. Balance reset to virtual start.');
        } else if (mode === 'REAL_LIVE' || mode === 'REAL_PAPER') {
             if (!binanceApiClient) {
                 botState.tradingMode = 'VIRTUAL'; // Revert
                 await saveData('state');
                 return res.status(400).json({ success: false, message: 'Binance API keys not set. Cannot switch to REAL mode.' });
             }
             try {
                const accountInfo = await binanceApiClient.getAccountInfo();
                const usdtBalance = accountInfo.balances.find(b => b.asset === 'USDT');
                if (usdtBalance) {
                    botState.balance = parseFloat(usdtBalance.free);
                    log('INFO', `Switched to ${mode} mode. Real USDT balance fetched: $${botState.balance.toFixed(2)}`);
                } else {
                    botState.balance = 0;
                    log('WARN', `Switched to ${mode} mode, but no USDT balance found.`);
                }
             } catch(error) {
                 botState.tradingMode = 'VIRTUAL'; // Revert on error
                 await saveData('state');
                 return res.status(500).json({ success: false, message: `Failed to fetch real balance: ${error.message}` });
             }
        }
        await saveData('state');
        log('INFO', `Trading mode switched to ${mode}.`);
        broadcast({ type: 'POSITIONS_UPDATED' }); // Trigger a full refresh
        res.json({ success: true, mode: botState.tradingMode });
    } else {
        res.status(400).json({ success: false, message: 'Invalid mode.' });
    }
});

// --- Serve Frontend ---
const __dirname = path.resolve();
app.use(express.static(path.join(__dirname, '..', 'dist')));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
});

// --- Initialize and Start Server ---
(async () => {
    try {
        await loadData();
        startBot();
        server.listen(port, () => {
            log('INFO', `Server running on http://localhost:${port}`);
        });
    } catch (error) {
        log('ERROR', `Failed to initialize and start server: ${error.message}`);
        process.exit(1);
    }
})();