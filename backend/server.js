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
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';


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
const AUTH_FILE_PATH = path.join(DATA_DIR, 'auth.json');
const KLINE_DATA_DIR = path.join(DATA_DIR, 'klines');
let db;

const ensureDataDirs = async () => {
    try { await fs.access(DATA_DIR); } catch { await fs.mkdir(DATA_DIR); }
    try { await fs.access(KLINE_DATA_DIR); } catch { await fs.mkdir(KLINE_DATA_DIR); }
};

// --- Database (SQLite) ---
const initDb = async () => {
    try {
        db = await open({
            filename: path.join(DATA_DIR, 'bot.db'),
            driver: sqlite3.Database
        });

        await db.exec(`
            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY,
                mode TEXT NOT NULL,
                symbol TEXT NOT NULL,
                side TEXT NOT NULL,
                entry_price REAL NOT NULL,
                average_entry_price REAL NOT NULL,
                exit_price REAL,
                quantity REAL NOT NULL,
                target_quantity REAL NOT NULL,
                total_cost_usd REAL NOT NULL,
                stop_loss REAL NOT NULL,
                initial_stop_loss REAL,
                take_profit REAL NOT NULL,
                highest_price_since_entry REAL NOT NULL,
                entry_time TEXT NOT NULL,
                exit_time TEXT,
                pnl REAL,
                pnl_pct REAL,
                status TEXT NOT NULL,
                is_at_breakeven INTEGER NOT NULL DEFAULT 0,
                partial_tp_hit INTEGER NOT NULL DEFAULT 0,
                realized_pnl REAL DEFAULT 0,
                trailing_stop_tightened INTEGER NOT NULL DEFAULT 0,
                is_scaling_in INTEGER NOT NULL DEFAULT 0,
                current_entry_count INTEGER DEFAULT 1,
                total_entries INTEGER DEFAULT 1,
                strategy_type TEXT,
                entry_snapshot TEXT,
                management_settings TEXT
            );

            CREATE TABLE IF NOT EXISTS key_value_store (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);
        log('INFO', 'SQLite database schema checked/created.');
    } catch (err) {
        log('ERROR', `Failed to initialize SQLite database: ${err.message}`);
        process.exit(1);
    }
};

const getKeyValue = async (key) => (await db.get('SELECT value FROM key_value_store WHERE key = ?', key))?.value;
const setKeyValue = async (key, value) => await db.run('INSERT OR REPLACE INTO key_value_store (key, value) VALUES (?, ?)', key, value);

const parseDbTrade = (dbRow) => {
    if (!dbRow) return null;
    return {
        ...dbRow,
        is_at_breakeven: !!dbRow.is_at_breakeven,
        partial_tp_hit: !!dbRow.partial_tp_hit,
        trailing_stop_tightened: !!dbRow.trailing_stop_tightened,
        is_scaling_in: !!dbRow.is_scaling_in,
        entry_snapshot: dbRow.entry_snapshot ? JSON.parse(dbRow.entry_snapshot) : null,
        management_settings: dbRow.management_settings ? JSON.parse(dbRow.management_settings) : null,
    };
};

const prepareTradeForDb = (trade) => {
    const dbTrade = { ...trade };
    for (const key of ['is_at_breakeven', 'partial_tp_hit', 'trailing_stop_tightened', 'is_scaling_in']) {
        dbTrade[key] = dbTrade[key] ? 1 : 0;
    }
    for (const key of ['entry_snapshot', 'management_settings']) {
        if (dbTrade[key]) {
            dbTrade[key] = JSON.stringify(dbTrade[key]);
        }
    }
    return dbTrade;
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
    
    // 1. Load settings from JSON (as it's config)
    try {
        const settingsContent = await fs.readFile(SETTINGS_FILE_PATH, 'utf-8');
        botState.settings = JSON.parse(settingsContent);
    } catch {
        log("WARN", "settings.json not found. Loading from .env defaults.");
        
        const isNotFalse = (envVar) => process.env[envVar] !== 'false';
        const isTrue = (envVar) => process.env[envVar] === 'true';

        botState.settings = {
            INITIAL_VIRTUAL_BALANCE: parseFloat(process.env.INITIAL_VIRTUAL_BALANCE) || 10000,
            MAX_OPEN_POSITIONS: parseInt(process.env.MAX_OPEN_POSITIONS, 10) || 5,
            POSITION_SIZE_PCT: parseFloat(process.env.POSITION_SIZE_PCT) || 2.0,
            RISK_REWARD_RATIO: parseFloat(process.env.RISK_REWARD_RATIO) || 4.0,
            STOP_LOSS_PCT: parseFloat(process.env.STOP_LOSS_PCT) || 2.0,
            SLIPPAGE_PCT: parseFloat(process.env.SLIPPAGE_PCT) || 0.05,
            MIN_VOLUME_USD: parseFloat(process.env.MIN_VOLUME_USD) || 40000000,
            SCANNER_DISCOVERY_INTERVAL_SECONDS: parseInt(process.env.SCANNER_DISCOVERY_INTERVAL_SECONDS, 10) || 3600,
            EXCLUDED_PAIRS: process.env.EXCLUDED_PAIRS || "USDCUSDT,FDUSDUSDT,TUSDUSDT,BUSDUSDT",
            LOSS_COOLDOWN_HOURS: parseInt(process.env.LOSS_COOLDOWN_HOURS, 10) || 4,
            BINANCE_API_KEY: process.env.BINANCE_API_KEY || '',
            BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY || '',
            USE_ATR_STOP_LOSS: isNotFalse('USE_ATR_STOP_LOSS'),
            ATR_MULTIPLIER: parseFloat(process.env.ATR_MULTIPLIER) || 1.5,
            USE_AUTO_BREAKEVEN: isNotFalse('USE_AUTO_BREAKEVEN'),
            BREAKEVEN_TRIGGER_R: parseFloat(process.env.BREAKEVEN_TRIGGER_R) || 1.0,
            ADJUST_BREAKEVEN_FOR_FEES: isNotFalse('ADJUST_BREAKEVEN_FOR_FEES'),
            TRANSACTION_FEE_PCT: parseFloat(process.env.TRANSACTION_FEE_PCT) || 0.1,
            USE_RSI_SAFETY_FILTER: isNotFalse('USE_RSI_SAFETY_FILTER'),
            RSI_OVERBOUGHT_THRESHOLD: parseInt(process.env.RSI_OVERBOUGHT_THRESHOLD, 10) || 75,
            USE_PARABOLIC_FILTER: isNotFalse('USE_PARABOLIC_FILTER'),
            PARABOLIC_FILTER_PERIOD_MINUTES: parseInt(process.env.PARABOLIC_FILTER_PERIOD_MINUTES, 10) || 5,
            PARABOLIC_FILTER_THRESHOLD_PCT: parseFloat(process.env.PARABOLIC_FILTER_THRESHOLD_PCT) || 2.5,
            USE_VOLUME_CONFIRMATION: isNotFalse('USE_VOLUME_CONFIRMATION'),
            USE_MARKET_REGIME_FILTER: isNotFalse('USE_MARKET_REGIME_FILTER'),
            USE_PARTIAL_TAKE_PROFIT: isTrue('USE_PARTIAL_TAKE_PROFIT'),
            PARTIAL_TP_TRIGGER_PCT: parseFloat(process.env.PARTIAL_TP_TRIGGER_PCT) || 0.8,
            PARTIAL_TP_SELL_QTY_PCT: parseInt(process.env.PARTIAL_TP_SELL_QTY_PCT, 10) || 50,
            USE_DYNAMIC_POSITION_SIZING: isTrue('USE_DYNAMIC_POSITION_SIZING'),
            STRONG_BUY_POSITION_SIZE_PCT: parseFloat(process.env.STRONG_BUY_POSITION_SIZE_PCT) || 3.0,
            REQUIRE_STRONG_BUY: isTrue('REQUIRE_STRONG_BUY'),
            USE_DYNAMIC_PROFILE_SELECTOR: isNotFalse('USE_DYNAMIC_PROFILE_SELECTOR'),
            ADX_THRESHOLD_RANGE: parseInt(process.env.ADX_THRESHOLD_RANGE, 10) || 20,
            ATR_PCT_THRESHOLD_VOLATILE: parseFloat(process.env.ATR_PCT_THRESHOLD_VOLATILE) || 5.0,
            USE_AGGRESSIVE_ENTRY_LOGIC: isTrue('USE_AGGRESSIVE_ENTRY_LOGIC'),
            USE_ADAPTIVE_TRAILING_STOP: isNotFalse('USE_ADAPTIVE_TRAILING_STOP'),
            TRAILING_STOP_TIGHTEN_THRESHOLD_R: parseFloat(process.env.TRAILING_STOP_TIGHTEN_THRESHOLD_R) || 1.0,
            TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION: parseFloat(process.env.TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION) || 0.3,
            CIRCUIT_BREAKER_WARN_THRESHOLD_PCT: parseFloat(process.env.CIRCUIT_BREAKER_WARN_THRESHOLD_PCT) || 1.5,
            CIRCUIT_BREAKER_HALT_THRESHOLD_PCT: parseFloat(process.env.CIRCUIT_BREAKER_HALT_THRESHOLD_PCT) || 2.5,
            DAILY_DRAWDOWN_LIMIT_PCT: parseFloat(process.env.DAILY_DRAWDOWN_LIMIT_PCT) || 3.0,
            CONSECUTIVE_LOSS_LIMIT: parseInt(process.env.CONSECUTIVE_LOSS_LIMIT, 10) || 5,
            USE_MTF_VALIDATION: isTrue('USE_MTF_VALIDATION'),
            USE_OBV_VALIDATION: isNotFalse('USE_OBV_VALIDATION'),
            USE_CVD_FILTER: isTrue('USE_CVD_FILTER'),
            USE_RSI_MTF_FILTER: isTrue('USE_RSI_MTF_FILTER'),
            RSI_15M_OVERBOUGHT_THRESHOLD: parseInt(process.env.RSI_15M_OVERBOUGHT_THRESHOLD, 10) || 70,
            USE_WICK_DETECTION_FILTER: isTrue('USE_WICK_DETECTION_FILTER'),
            MAX_UPPER_WICK_PCT: parseFloat(process.env.MAX_UPPER_WICK_PCT) || 50,
            USE_OBV_5M_VALIDATION: isTrue('USE_OBV_5M_VALIDATION'),
            SCALING_IN_CONFIG: process.env.SCALING_IN_CONFIG || "50,50",
            MAX_CORRELATED_TRADES: parseInt(process.env.MAX_CORRELATED_TRADES, 10) || 2,
            USE_FEAR_AND_GREED_FILTER: isTrue('USE_FEAR_AND_GREED_FILTER'),
            USE_ORDER_BOOK_LIQUIDITY_FILTER: isTrue('USE_ORDER_BOOK_LIQUIDITY_FILTER'),
            MIN_ORDER_BOOK_LIQUIDITY_USD: parseInt(process.env.MIN_ORDER_BOOK_LIQUIDITY_USD, 10) || 200000,
            USE_SECTOR_CORRELATION_FILTER: isTrue('USE_SECTOR_CORRELATION_FILTER'),
            USE_WHALE_MANIPULATION_FILTER: isTrue('USE_WHALE_MANIPULATION_FILTER'),
            WHALE_SPIKE_THRESHOLD_PCT: parseFloat(process.env.WHALE_SPIKE_THRESHOLD_PCT) || 5.0,
            USE_IGNITION_STRATEGY: isTrue('USE_IGNITION_STRATEGY'),
            IGNITION_PRICE_THRESHOLD_PCT: parseFloat(process.env.IGNITION_PRICE_THRESHOLD_PCT) || 5.0,
            IGNITION_VOLUME_MULTIPLIER: parseInt(process.env.IGNITION_VOLUME_MULTIPLIER, 10) || 10,
            USE_FLASH_TRAILING_STOP: isTrue('USE_FLASH_TRAILING_STOP'),
            FLASH_TRAILING_STOP_PCT: parseFloat(process.env.FLASH_TRAILING_STOP_PCT) || 1.5,
        };
        await fs.writeFile(SETTINGS_FILE_PATH, JSON.stringify(botState.settings, null, 2));
    }

    // 2. Initialize DB connection
    await initDb();
    
    // 3. Initialize key-value store with defaults if they don't exist
    await db.run("INSERT OR IGNORE INTO key_value_store (key, value) VALUES ('balance', ?)", botState.settings.INITIAL_VIRTUAL_BALANCE.toString());
    await db.run("INSERT OR IGNORE INTO key_value_store (key, value) VALUES ('isRunning', 'true')");
    await db.run("INSERT OR IGNORE INTO key_value_store (key, value) VALUES ('tradingMode', 'VIRTUAL')");
    await db.run("INSERT OR IGNORE INTO key_value_store (key, value) VALUES ('dayStartBalance', ?)", botState.settings.INITIAL_VIRTUAL_BALANCE.toString());
    await db.run("INSERT OR IGNORE INTO key_value_store (key, value) VALUES ('dailyPnl', '0')");
    await db.run("INSERT OR IGNORE INTO key_value_store (key, value) VALUES ('consecutiveLosses', '0')");
    await db.run("INSERT OR IGNORE INTO key_value_store (key, value) VALUES ('consecutiveWins', '0')");
    await db.run("INSERT OR IGNORE INTO key_value_store (key, value) VALUES ('currentTradingDay', ?)", new Date().toISOString().split('T')[0]);

    // 4. Load state from DB into memory
    botState.balance = parseFloat(await getKeyValue('balance'));
    botState.isRunning = (await getKeyValue('isRunning')) === 'true';
    botState.tradingMode = await getKeyValue('tradingMode');
    botState.dayStartBalance = parseFloat(await getKeyValue('dayStartBalance'));
    botState.dailyPnl = parseFloat(await getKeyValue('dailyPnl'));
    botState.consecutiveLosses = parseInt(await getKeyValue('consecutiveLosses'), 10);
    botState.consecutiveWins = parseInt(await getKeyValue('consecutiveWins'), 10);
    botState.currentTradingDay = await getKeyValue('currentTradingDay');

    const allTrades = await db.all('SELECT * FROM trades');
    botState.activePositions = allTrades.filter(t => t.status !== 'CLOSED').map(parseDbTrade);
    botState.tradeHistory = allTrades.filter(t => t.status === 'CLOSED').map(parseDbTrade);
    log('INFO', `Loaded ${botState.activePositions.length} active positions and ${botState.tradeHistory.length} historical trades from DB.`);


    // 5. Load auth from JSON
    try {
        const authContent = await fs.readFile(AUTH_FILE_PATH, 'utf-8');
        botState.passwordHash = JSON.parse(authContent).passwordHash;
    } catch {
        log("WARN", "auth.json not found. Initializing from .env.");
        const initialPassword = process.env.APP_PASSWORD;
        if (!initialPassword) {
            log('ERROR', 'CRITICAL: APP_PASSWORD is not set in .env. Please set it and restart.');
            process.exit(1);
        }
        botState.passwordHash = await hashPassword(initialPassword);
        await fs.writeFile(AUTH_FILE_PATH, JSON.stringify({ passwordHash: botState.passwordHash }, null, 2));
    }
    
    realtimeAnalyzer.updateSettings(botState.settings);
};

const saveData = async (type) => {
    // This function is now only for settings and auth, state is saved directly to DB.
    await ensureDataDirs();
    if (type === 'settings') {
        await fs.writeFile(SETTINGS_FILE_PATH, JSON.stringify(botState.settings, null, 2));
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

        if (!pairToUpdate || !pairToUpdate.conditions?.trend4h_score) return;

        const klines15m = this.klineData.get(symbol)?.get('15m');
        if (!klines15m || klines15m.length < 200) return;

        const old_hotlist_status = pairToUpdate.is_on_hotlist;

        const closes15m = klines15m.map(d => d.close);
        const highs15m = klines15m.map(d => d.high);
        const lows15m = klines15m.map(d => d.low);
        const volumes15m = klines15m.map(k => k.volume);
        const lastClose15m = closes15m[closes15m.length - 1];

        // --- Calculate all 15m indicators for display ---
        const rsi15m = RSI.calculate({ period: 14, values: closes15m }).pop();
        const adxInput = { high: highs15m, low: lows15m, close: closes15m, period: 14 };
        const adxResult = ADX.calculate(adxInput).pop();
        const adx15m = adxResult ? adxResult.adx : undefined;
        const atrInput = { high: highs15m, low: lows15m, close: closes15m, period: 14 };
        const atr15m = ATR.calculate(atrInput).pop();
        const atr_pct_15m = atr15m ? (atr15m / lastClose15m) * 100 : undefined;

        const bbInput = { period: 20, values: closes15m, stdDev: 2 };
        const bbResult = BollingerBands.calculate(bbInput);
        const lastBb = bbResult.length > 0 ? bbResult[bbResult.length - 1] : null;
        let bb_width_pct, is_in_squeeze_15m = false;
        if (lastBb && lastBb.middle > 0) {
            bb_width_pct = ((lastBb.upper - lastBb.lower) / lastBb.middle) * 100;
            // A simple squeeze check: width is less than 3%
            is_in_squeeze_15m = bb_width_pct < 3.0;
        }
        
        // --- 15m Trend Score ---
        let trend15m_score = 0;
        const ema50_15m = EMA.calculate({ period: 50, values: closes15m }).pop();
        const ema200_15m = EMA.calculate({ period: 200, values: closes15m }).pop();
        if(lastClose15m > ema50_15m) trend15m_score += 0.5; else trend15m_score -= 0.5;
        if(ema50_15m > ema200_15m) trend15m_score += 0.5; else trend15m_score -= 0.5;
        if(rsi15m > 55) trend15m_score += 0.5; else if(rsi15m < 45) trend15m_score -= 0.5;
        const macd_15m = MACD.calculate({ values: closes15m, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, simpleMAOscillator: false, simpleMASignal: false }).pop();
        if(macd_15m && macd_15m.MACD > macd_15m.signal) trend15m_score += 0.5; else if(macd_15m && macd_15m.MACD < macd_15m.signal) trend15m_score -= 0.5;
        trend15m_score = Math.max(-2, Math.min(2, trend15m_score));

        // --- Relative Volume Score ---
        const avgVolume = volumes15m.slice(-97, -1).reduce((sum, v) => sum + v, 0) / 96; // 24h average
        const lastVolume = volumes15m[volumes15m.length - 1];
        let volume_score = 0;
        const volumeRatio = lastVolume / avgVolume;
        if (volumeRatio > 2.0) volume_score = 3;
        else if (volumeRatio > 1.5) volume_score = 2;
        else if (volumeRatio > 1.3) volume_score = 1;

        // --- BTC/ETH Correlation (simplified) ---
        let btc_corr_score = 1; // Default to +1 as per spec for now.
        
        const hotlist_score = pairToUpdate.conditions.trend4h_score + trend15m_score + volume_score + btc_corr_score;
        const isOnHotlist = hotlist_score >= 5;

        // --- FINAL STATE UPDATE ---
        pairToUpdate.rsi_15m = rsi15m;
        pairToUpdate.adx_15m = adx15m;
        pairToUpdate.atr_15m = atr15m;
        pairToUpdate.atr_pct_15m = atr_pct_15m;
        pairToUpdate.bollinger_bands_15m = {
            upper: lastBb?.upper,
            middle: lastBb?.middle,
            lower: lastBb?.lower,
            width_pct: bb_width_pct
        };
        pairToUpdate.is_in_squeeze_15m = is_in_squeeze_15m;

        pairToUpdate.is_on_hotlist = isOnHotlist;
        pairToUpdate.conditions.trend15m_score = trend15m_score;
        pairToUpdate.conditions.volume_score = volume_score;
        pairToUpdate.conditions.hotlist_score = hotlist_score;
        pairToUpdate.score_value = hotlist_score * 10; // Normalize to ~0-100 for UI

        if (isOnHotlist && !old_hotlist_status) {
            this.log('SCANNER', `[HOTLIST ADD] ${symbol} now meets criteria with score ${hotlist_score.toFixed(1)}. Watching on micro TFs.`);
            addSymbolToMicroStreams(symbol);
        } else if (!isOnHotlist && old_hotlist_status) {
            this.log('SCANNER', `[HOTLIST REMOVE] ${symbol} no longer meets criteria (score ${hotlist_score.toFixed(1)}).`);
            removeSymbolFromMicroStreams(symbol);
        }

        if (isOnHotlist) {
            pairToUpdate.score = 'COMPRESSION';
            pairToUpdate.strategy_type = 'PRECISION';
        } else {
             pairToUpdate.score = 'HOLD';
             pairToUpdate.strategy_type = undefined;
        }
        
        broadcast({ type: 'SCANNER_UPDATE', payload: pairToUpdate });
    }
    
    // Phase 2: 1m analysis to find the precision entry for pairs on the Hotlist
    async checkForMicroTrigger(symbol, tradeSettings) {
        const pair = botState.scannerCache.find(p => p.symbol === symbol);
        if (!pair || !pair.is_on_hotlist || botState.pendingConfirmation.has(symbol)) return;

        const klines1m = this.klineData.get(symbol)?.get('1m');
        if (!klines1m || klines1m.length < 61) return;

        const closes1m = klines1m.map(k => k.close);
        const volumes1m = klines1m.map(k => k.volume);
        
        let score_1m = 0;
        let is_ignition_signal = false;

        // Condition 1: Close > EMA9
        const lastEma9 = EMA.calculate({ period: 9, values: closes1m }).pop();
        if (klines1m[klines1m.length - 1].close > lastEma9) {
            score_1m += 1;
        }

        // Condition 2: RSI Crossover
        const rsi_1m = RSI.calculate({period: 14, values: closes1m});
        if(rsi_1m.length > 1 && rsi_1m[rsi_1m.length-1] > 50 && rsi_1m[rsi_1m.length-2] <= 50) {
            score_1m += 1;
        }

        // Condition 3: MACD Crossover
        const macd_1m_input = { values: closes1m, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, simpleMAOscillator: false, simpleMASignal: false };
        const macd_1m = MACD.calculate(macd_1m_input);
        if(macd_1m.length > 1) {
            const curr = macd_1m[macd_1m.length - 1];
            const prev = macd_1m[macd_1m.length - 2];
            if(curr.MACD > curr.signal && prev.MACD <= prev.signal) {
                score_1m += 1;
            }
        }

        // Condition 4: Volume Spike
        const avgVolume = volumes1m.slice(-21, -1).reduce((sum, v) => sum + v, 0) / 20;
        const volumeRatio = volumes1m[volumes1m.length - 1] / avgVolume;
        if (volumeRatio > 1.5) {
            score_1m += 2;
        }

        // Check for Ignition conditions
        if (volumeRatio > 1.5 && rsi_1m.length > 0 && rsi_1m[rsi_1m.length - 1] > 55 && macd_1m.length > 0 && macd_1m[macd_1m.length - 1].MACD > 0) {
            is_ignition_signal = true;
        }
        
        const triggerCandle = klines1m[klines1m.length-1];

        // --- LOGIC REFACTORED FOR CLARITY AND CORRECTNESS ---

        // Case 1: MTF Validation is DISABLED. We evaluate the trade directly on the 1m signal.
        if (tradeSettings.USE_MTF_VALIDATION === false) {
            // The threshold must be achievable by the 1m score alone. Max 1m score is 5.
            // A score of 4 or 5 is a very strong 1m signal.
            const directTradeThreshold = 4;
            if (score_1m >= directTradeThreshold) {
                this.log('TRADE', `[DIRECT TRIGGER 1m - ${is_ignition_signal ? 'IGNITION' : 'PRECISION'}] MTF validation is OFF. Score ${score_1m} >= ${directTradeThreshold}. Firing trade.`);
                const tradeOpened = await tradingEngine.evaluateAndOpenTrade(pair, triggerCandle.low, tradeSettings);
                if (tradeOpened) {
                    pair.is_on_hotlist = false;
                    pair.strategy_type = undefined;
                    removeSymbolFromMicroStreams(symbol);
                    broadcast({ type: 'SCANNER_UPDATE', payload: pair });
                }
            }
            return; // Stop further processing for this candle
        }
        
        // Case 2: MTF Validation is ENABLED. We check for a reasonably strong 1m signal to put into pending.
        // A score of 1 is too weak and creates noise. Let's require at least 3.
        const pendingThreshold = 3;
        if (score_1m >= pendingThreshold) {
            const strategy_type = is_ignition_signal ? 'IGNITION' : 'PRECISION';
            pair.score = 'PENDING_CONFIRMATION';
            pair.strategy_type = strategy_type;
            botState.pendingConfirmation.set(symbol, {
                triggerPrice: triggerCandle.close,
                triggerTimestamp: Date.now(),
                slPriceReference: triggerCandle.low,
                settings: tradeSettings,
                strategy_type: strategy_type,
                micro_score_1m: score_1m,
            });
            this.log('TRADE', `[MICRO TRIGGER 1m] Signal for ${symbol} with score ${score_1m}. Pending 5m confirmation. Ignition: ${is_ignition_signal}`);
            broadcast({ type: 'SCANNER_UPDATE', payload: pair });
        }
    }

    async validate5mConfirmation(symbol, new5mCandle) {
        const pendingSignal = botState.pendingConfirmation.get(symbol);
        if (!pendingSignal) return;
        
        const pair = botState.scannerCache.find(p => p.symbol === symbol);
        if (!pair) return;

        const { triggerPrice, slPriceReference, settings, strategy_type, micro_score_1m } = pendingSignal;
        
        let score_5m = 0;
        const klines5m = this.klineData.get(symbol)?.get('5m');
        if (new5mCandle.close > new5mCandle.open && new5mCandle.close > triggerPrice) {
            score_5m = 2; // "Confirms"
        } else if (klines5m && klines5m.length > 14) {
            const closes5m = klines5m.map(k => k.close);
            const highs5m = klines5m.map(k => k.high);
            const lows5m = klines5m.map(k => k.low);
            const atr5m = ATR.calculate({high: highs5m, low: lows5m, close: closes5m, period: 14}).pop();
            const bodySize = Math.abs(new5mCandle.open - new5mCandle.close);
            if (new5mCandle.close < new5mCandle.open && bodySize > atr5m) {
                score_5m = -1; // "Strong contradiction"
            }
        }
        
        const final_micro_score = micro_score_1m + score_5m;
        const threshold = strategy_type === 'IGNITION' ? 6 : 8;

        if (final_micro_score >= threshold) {
            this.log('TRADE', `[MTF SUCCESS - ${strategy_type}] 5m confirmed for ${symbol}. Final score ${final_micro_score} >= ${threshold}.`);
            const tradeOpened = await tradingEngine.evaluateAndOpenTrade(pair, slPriceReference, settings);
            if (tradeOpened) {
                pair.is_on_hotlist = false;
                pair.strategy_type = undefined;
                removeSymbolFromMicroStreams(symbol);
            }
        } else {
            this.log('TRADE', `[MTF FAILED - ${strategy_type}] 5m did not confirm for ${symbol}. Final score ${final_micro_score} < ${threshold}.`);
            pair.score = 'FAKE_BREAKOUT';
            pair.strategy_type = undefined;
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
            // FIX: The function checkGlobalSafetyRules is async and must be awaited.
            await checkGlobalSafetyRules();
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
            this.validate5mConfirmation(symbol, kline);
        } else if (interval === '1m') {
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
            this.checkForMicroTrigger(symbol, tradeSettings);

            if (tradeSettings.SCALING_IN_CONFIG && tradeSettings.SCALING_IN_CONFIG.trim() !== '') {
                const position = botState.activePositions.find(p => p.symbol === symbol && p.is_scaling_in);
                if (position && kline.close > kline.open) { // Bullish confirmation candle
                    tradingEngine.scaleInPosition(position, kline.close, tradeSettings);
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
    activePositions: [], // In-memory cache of active positions from DB
    tradeHistory: [], // In-memory cache of historical trades from DB
    scannerCache: [],
    isRunning: true,
    tradingMode: 'VIRTUAL',
    passwordHash: '',
    recentlyLostSymbols: new Map(),
    hotlist: new Set(),
    pendingConfirmation: new Map(),
    priceCache: new Map(),
    circuitBreakerStatus: 'NONE',
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
                existingPair.conditions.trend4h_score = discoveredPair.conditions.trend4h_score;
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
        PARTIAL_TP_TRIGGER_PCT: 1.0, PARTIAL_TP_SELL_QTY_PCT: 50, USE_AUTO_BREAKEVEN: true, BREAKEVEN_TRIGGER_R: 1.0,
        ADJUST_BREAKEVEN_FOR_FEES: true, TRANSACTION_FEE_PCT: 0.1, USE_ADAPTIVE_TRAILING_STOP: true,
        TRAILING_STOP_TIGHTEN_THRESHOLD_R: 1.5, TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION: 0.5, RISK_REWARD_RATIO: 5.0,
        USE_AGGRESSIVE_ENTRY_LOGIC: false,
    },
    'Le Scalpeur': {
        POSITION_SIZE_PCT: 3.0, MAX_OPEN_POSITIONS: 5, REQUIRE_STRONG_BUY: false, USE_RSI_SAFETY_FILTER: true,
        RSI_OVERBOUGHT_THRESHOLD: 70, USE_PARABOLIC_FILTER: true, PARABOLIC_FILTER_PERIOD_MINUTES: 5,
        PARABOLIC_FILTER_THRESHOLD_PCT: 3.5, USE_ATR_STOP_LOSS: false, STOP_LOSS_PCT: 0.3, RISK_REWARD_RATIO: 2.0,
        USE_PARTIAL_TAKE_PROFIT: false, USE_AUTO_BREAKEVEN: false, ADJUST_BREAKEVEN_FOR_FEES: false,
        TRANSACTION_FEE_PCT: 0.1, USE_ADAPTIVE_TRAILING_STOP: false, USE_AGGRESSIVE_ENTRY_LOGIC: false,
    },
    'Le Chasseur de Volatilité': {
        POSITION_SIZE_PCT: 4.0, MAX_OPEN_POSITIONS: 8, REQUIRE_STRONG_BUY: false, USE_RSI_SAFETY_FILTER: false,
        RSI_OVERBOUGHT_THRESHOLD: 80, USE_PARABOLIC_FILTER: false, USE_ATR_STOP_LOSS: true, ATR_MULTIPLIER: 2.0,
        RISK_REWARD_RATIO: 3.0, USE_PARTIAL_TAKE_PROFIT: false, USE_AUTO_BREAKEVEN: true, BREAKEVEN_TRIGGER_R: 2.0,
        ADJUST_BREAKEVEN_FOR_FEES: true, TRANSACTION_FEE_PCT: 0.1, USE_ADAPTIVE_TRAILING_STOP: true,
        TRAILING_STOP_TIGHTEN_THRESHOLD_R: 1.0, TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION: 0.5,
        USE_AGGRESSIVE_ENTRY_LOGIC: true,
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
            id: null, // DB will assign ID
            mode: botState.tradingMode,
            symbol: pair.symbol,
            side: 'BUY',
            entry_price: entryPrice,
            average_entry_price: entryPrice,
            quantity: initial_quantity,
            target_quantity: target_quantity,
            total_cost_usd: initial_cost,
            stop_loss: stopLoss,
            initial_stop_loss: stopLoss,
            take_profit: takeProfit,
            highest_price_since_entry: entryPrice,
            entry_time: new Date().toISOString(),
            status: 'FILLED',
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

        const dbTrade = prepareTradeForDb(newTrade);
        const { id, ...dbTradeToInsert } = dbTrade; // Exclude null id
        const columns = Object.keys(dbTradeToInsert).join(', ');
        const placeholders = Object.keys(dbTradeToInsert).map(() => '?').join(', ');

        const result = await db.run(`INSERT INTO trades (${columns}) VALUES (${placeholders})`, Object.values(dbTradeToInsert));
        newTrade.id = result.lastID;
        botState.activePositions.push(newTrade);
        
        if (botState.tradingMode === 'VIRTUAL') {
            botState.balance -= initial_cost;
            await setKeyValue('balance', botState.balance);
        }

        log('TRADE', `>>> TRADE OPENED (ID: ${newTrade.id}, STRATEGY: ${newTrade.strategy_type || 'N/A'}, ENTRY 1/${newTrade.total_entries}) <<< Opening ${botState.tradingMode} trade for ${pair.symbol}: Qty=${initial_quantity.toFixed(4)}, Entry=$${entryPrice}`);
        
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
                await db.run('UPDATE trades SET is_scaling_in = 0 WHERE id = ?', position.id);
                return;
            }
        }
        
        const chunkCost = chunkQty * newPrice;

        if (botState.tradingMode === 'VIRTUAL' && botState.balance < chunkCost) {
            log('WARN', `[SCALING IN] Insufficient virtual balance to scale in for ${position.symbol}.`);
            position.is_scaling_in = false;
            await db.run('UPDATE trades SET is_scaling_in = 0 WHERE id = ?', position.id);
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
            await setKeyValue('balance', botState.balance);
        }

        const riskPerUnit = position.average_entry_price - position.initial_stop_loss;
        position.take_profit = position.average_entry_price + (riskPerUnit * tradeSettings.RISK_REWARD_RATIO);

        if (position.current_entry_count >= position.total_entries) {
            position.is_scaling_in = false;
            log('TRADE', `[SCALING IN] Final entry for ${position.symbol} complete.`);
        }
        
        await db.run(
            'UPDATE trades SET average_entry_price = ?, quantity = ?, total_cost_usd = ?, current_entry_count = ?, take_profit = ?, is_scaling_in = ? WHERE id = ?',
            position.average_entry_price, position.quantity, position.total_cost_usd, position.current_entry_count, position.take_profit, position.is_scaling_in ? 1 : 0, position.id
        );

        log('TRADE', `[SCALING IN] Entry ${position.current_entry_count}/${position.total_entries} for ${position.symbol} at $${newPrice}. New Avg Price: $${position.average_entry_price.toFixed(4)}`);
        
        broadcast({ type: 'POSITIONS_UPDATED' });
    },

    async monitorAndManagePositions() {
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
                    pair.strategy_type = undefined;
                    broadcast({ type: 'SCANNER_UPDATE', payload: pair });
                }
            }
        }

        const positionsToClose = [];
        for (const pos of botState.activePositions) {
            const priceData = botState.priceCache.get(pos.symbol);
            if (!priceData) {
                log('WARN', `No price data available for active position ${pos.symbol}. Skipping management check.`);
                continue;
            }

            const s = pos.management_settings || botState.settings;
            const currentPrice = priceData.price;
            let changes = {};

            if (currentPrice > pos.highest_price_since_entry) {
                pos.highest_price_since_entry = currentPrice;
                changes.highest_price_since_entry = currentPrice;
            }

            if (currentPrice <= pos.stop_loss) {
                positionsToClose.push({ trade: pos, exitPrice: pos.stop_loss, reason: 'Stop Loss' });
                continue;
            }

            if (currentPrice >= pos.take_profit) {
                positionsToClose.push({ trade: pos, exitPrice: pos.take_profit, reason: 'Take Profit' });
                continue;
            }
            
            let currentR = 0;
            if (pos.initial_stop_loss) {
                const initialRiskPerUnit = pos.average_entry_price - pos.initial_stop_loss;
                if (initialRiskPerUnit > 0) {
                    currentR = (currentPrice - pos.average_entry_price) / initialRiskPerUnit;
                }
            }
            
            const pnlPct = ((currentPrice - pos.average_entry_price) / pos.average_entry_price) * 100;

            // --- STRATEGY-SPECIFIC MANAGEMENT ---
            const isIgnition = pos.strategy_type === 'IGNITION';

            if (isIgnition && s.USE_FLASH_TRAILING_STOP) {
                // If flash trailing is not yet active (use is_at_breakeven as the flag) and profit is >= 0.5%
                if (!pos.is_at_breakeven && pnlPct >= 0.5) {
                    pos.is_at_breakeven = true;
                    changes.is_at_breakeven = 1;
                    const newStopLoss = pos.average_entry_price * 1.0005; // Lock in minuscule profit
                    if (newStopLoss > pos.stop_loss) {
                        pos.stop_loss = newStopLoss;
                        changes.stop_loss = newStopLoss;
                        log('TRADE', `[${pos.symbol}] IGNITION ⚡ FLASH SL ACTIVATED at $${newStopLoss.toFixed(4)}.`);
                    }
                }
                // If flash trailing is active, trail the price tightly
                if (pos.is_at_breakeven) {
                    const newTrailingSL = pos.highest_price_since_entry * (1 - s.FLASH_TRAILING_STOP_PCT / 100);
                    if (newTrailingSL > pos.stop_loss) {
                        pos.stop_loss = newTrailingSL;
                        changes.stop_loss = newTrailingSL;
                    }
                }
            } else {
                 // --- STANDARD MANAGEMENT LOGIC ---
                if (s.USE_PARTIAL_TAKE_PROFIT && !pos.partial_tp_hit && pnlPct >= s.PARTIAL_TP_TRIGGER_PCT) {
                    await this.executePartialSell(pos, currentPrice, s); // This now updates DB
                }

                if (s.USE_AUTO_BREAKEVEN && !pos.is_at_breakeven && currentR >= s.BREAKEVEN_TRIGGER_R) {
                    let newStopLoss = pos.average_entry_price;
                    if (s.ADJUST_BREAKEVEN_FOR_FEES && s.TRANSACTION_FEE_PCT > 0) {
                        newStopLoss *= (1 + (s.TRANSACTION_FEE_PCT / 100) * 2);
                    }
                    pos.stop_loss = newStopLoss;
                    pos.is_at_breakeven = true;
                    changes = {...changes, stop_loss: newStopLoss, is_at_breakeven: 1 };
                    log('TRADE', `[${pos.symbol}] Profit at ${currentR.toFixed(2)}R. SL moved to Break-even at $${newStopLoss.toFixed(4)}.`);
                }
                
                if (s.USE_ADAPTIVE_TRAILING_STOP && pos.is_at_breakeven && pos.entry_snapshot?.atr_15m) {
                    let atrMultiplier = s.ATR_MULTIPLIER;
                    
                    if (currentR >= s.TRAILING_STOP_TIGHTEN_THRESHOLD_R) {
                        if (!pos.trailing_stop_tightened) {
                            atrMultiplier -= s.TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION;
                            pos.trailing_stop_tightened = true;
                            changes.trailing_stop_tightened = 1;
                            log('TRADE', `[${pos.symbol}] Adaptive SL: Profit > ${s.TRAILING_STOP_TIGHTEN_THRESHOLD_R}R. Tightening ATR multiplier to ${atrMultiplier.toFixed(2)}.`);
                        } else {
                             atrMultiplier -= s.TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION;
                        }
                    }
                    
                    const newTrailingSL = pos.highest_price_since_entry - (pos.entry_snapshot.atr_15m * atrMultiplier);
                    if (newTrailingSL > pos.stop_loss) {
                        pos.stop_loss = newTrailingSL;
                        changes.stop_loss = newTrailingSL;
                    }
                }
            }
            
            if (Object.keys(changes).length > 0) {
                const setClauses = Object.keys(changes).map(k => `${k} = ?`).join(', ');
                await db.run(`UPDATE trades SET ${setClauses} WHERE id = ?`, [...Object.values(changes), pos.id]);
            }
        }

        if (positionsToClose.length > 0) {
            for (const { trade, exitPrice, reason } of positionsToClose) {
                await this.closeTrade(trade.id, exitPrice, reason);
            }
            broadcast({ type: 'POSITIONS_UPDATED' });
        }
    },

    async closeTrade(tradeId, exitPrice, reason = 'Manual Close') {
        const tradeIndex = botState.activePositions.findIndex(t => t.id === tradeId);
        if (tradeIndex === -1) {
            log('WARN', `Could not find active trade with ID ${tradeId} to close.`);
            return null;
        }
        let trade = botState.activePositions[tradeIndex];

        if (trade.mode === 'REAL_LIVE') {
            if (!binanceApiClient) {
                log('ERROR', `[REAL_LIVE] Cannot close trade for ${trade.symbol}. API client not initialized.`);
                return null;
            }
            try {
                const formattedQty = formatQuantity(trade.symbol, trade.quantity);
                log('TRADE', `>>> [REAL_LIVE] CLOSING TRADE <<< Selling ${formattedQty} ${trade.symbol} at MARKET.`);
                const orderResult = await binanceApiClient.createOrder(trade.symbol, 'SELL', 'MARKET', formattedQty);
                log('BINANCE_API', `[REAL_LIVE] Close order successful for ${trade.symbol}. ID: ${orderResult.orderId}`);
                
                if (parseFloat(orderResult.executedQty) > 0) {
                    exitPrice = parseFloat(orderResult.cummulativeQuoteQty) / parseFloat(orderResult.executedQty);
                    log('TRADE', `[REAL_LIVE] Actual average exit price for ${trade.symbol} is $${exitPrice.toFixed(4)}.`);
                }
            } catch (error) {
                 log('ERROR', `[REAL_LIVE] FAILED to place closing order for ${trade.symbol}. Error: ${error.message}. MANUAL INTERVENTION REQUIRED.`);
                return null;
            }
        }
        
        botState.activePositions.splice(tradeIndex, 1);
        
        trade.exit_price = exitPrice;
        trade.exit_time = new Date().toISOString();
        trade.status = 'CLOSED';

        const exitValue = exitPrice * trade.quantity;
        const pnl = (trade.realized_pnl || 0) + exitValue - trade.total_cost_usd;
        const initialFullPositionValue = trade.average_entry_price * trade.target_quantity;

        trade.pnl = pnl;
        trade.pnl_pct = initialFullPositionValue > 0 ? (pnl / initialFullPositionValue) * 100 : 0;

        await db.run(
            'UPDATE trades SET status = ?, exit_price = ?, exit_time = ?, pnl = ?, pnl_pct = ? WHERE id = ?',
            'CLOSED', trade.exit_price, trade.exit_time, trade.pnl, trade.pnl_pct, trade.id
        );

        if (trade.mode === 'VIRTUAL') {
            botState.balance += trade.total_cost_usd + pnl;
            await setKeyValue('balance', botState.balance);
        } else {
             botState.balance += pnl;
             await setKeyValue('balance', botState.balance);
        }
        
        const today = new Date().toISOString().split('T')[0];
        if (today !== botState.currentTradingDay) {
            log('INFO', `New trading day. Resetting daily stats. Previous day PnL: $${botState.dailyPnl.toFixed(2)}`);
            botState.dailyPnl = 0;
            botState.consecutiveLosses = 0;
            botState.consecutiveWins = 0;
            botState.currentTradingDay = today;
            botState.dayStartBalance = botState.balance;
            await setKeyValue('dailyPnl', 0);
            await setKeyValue('consecutiveLosses', 0);
            await setKeyValue('consecutiveWins', 0);
            await setKeyValue('currentTradingDay', today);
            await setKeyValue('dayStartBalance', botState.balance);

            if (botState.circuitBreakerStatus === 'HALTED_DRAWDOWN') {
                botState.circuitBreakerStatus = 'NONE';
                broadcast({ type: 'CIRCUIT_BREAKER_UPDATE', payload: { status: 'NONE' } });
            }
        }

        botState.dailyPnl += pnl;
        await setKeyValue('dailyPnl', botState.dailyPnl);

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
        await setKeyValue('consecutiveLosses', botState.consecutiveLosses);
        await setKeyValue('consecutiveWins', botState.consecutiveWins);
        
        // FIX: The function checkGlobalSafetyRules is async and must be awaited.
        await checkGlobalSafetyRules();
        botState.tradeHistory.push(trade);
        
        if (pnl < 0 && botState.settings.LOSS_COOLDOWN_HOURS > 0) {
            const cooldownUntil = Date.now() + botState.settings.LOSS_COOLDOWN_HOURS * 60 * 60 * 1000;
            botState.recentlyLostSymbols.set(trade.symbol, { until: cooldownUntil });
            log('TRADE', `[${trade.symbol}] placed on cooldown until ${new Date(cooldownUntil).toLocaleString()}`);
        }
        
        log('TRADE', `<<< TRADE CLOSED >>> [${reason}] Closed ${trade.symbol} at $${exitPrice.toFixed(4)}. PnL: $${pnl.toFixed(2)} (${trade.pnl_pct.toFixed(2)}%)`);
        return trade;
    },
    
    async executePartialSell(position, currentPrice, settings) {
        if (position.mode !== 'VIRTUAL') return;

        const sellQty = position.target_quantity * (settings.PARTIAL_TP_SELL_QTY_PCT / 100);
        const pnlFromSale = (currentPrice - position.average_entry_price) * sellQty;

        position.quantity -= sellQty;
        position.total_cost_usd -= position.average_entry_price * sellQty;
        position.realized_pnl = (position.realized_pnl || 0) + pnlFromSale;
        position.partial_tp_hit = true;
        
        await db.run(
            'UPDATE trades SET quantity = ?, total_cost_usd = ?, realized_pnl = ?, partial_tp_hit = 1 WHERE id = ?',
            position.quantity, position.total_cost_usd, position.realized_pnl, position.id
        );
        log('TRADE', `[PARTIAL TP] Sold ${settings.PARTIAL_TP_SELL_QTY_PCT}% of ${position.symbol} at $${currentPrice}. Realized PnL: $${pnlFromSale.toFixed(2)}`);
    }
};

// FIX: This function uses await and must be declared async.
const checkGlobalSafetyRules = async () => {
    const s = botState.settings;
    let newStatus = botState.circuitBreakerStatus;
    let statusReason = "";

    if (newStatus === 'HALTED_BTC_DROP' || newStatus === 'HALTED_DRAWDOWN') return; 

    const drawdownLimitUSD = (botState.dayStartBalance * (s.DAILY_DRAWDOWN_LIMIT_PCT / 100));
    if (botState.dailyPnl < 0 && Math.abs(botState.dailyPnl) >= drawdownLimitUSD) {
        newStatus = 'HALTED_DRAWDOWN';
        statusReason = `Daily drawdown limit of -$${drawdownLimitUSD.toFixed(2)} reached. Trading halted for the day.`;
    } else if (botState.consecutiveLosses >= s.CONSECUTIVE_LOSS_LIMIT) {
        newStatus = 'PAUSED_LOSS_STREAK';
        statusReason = `${s.CONSECUTIVE_LOSS_LIMIT} consecutive losses reached. Trading is paused.`;
    } else if (s.USE_FEAR_AND_GREED_FILTER && botState.fearAndGreed) {
        if (botState.fearAndGreed.value <= 15 || botState.fearAndGreed.value >= 85) {
            newStatus = 'PAUSED_EXTREME_SENTIMENT';
            statusReason = `Extreme market sentiment detected (F&G: ${botState.fearAndGreed.value}). Trading paused.`;
        } else if (newStatus === 'PAUSED_EXTREME_SENTIMENT') {
            newStatus = 'NONE';
            statusReason = 'Market sentiment has returned to normal levels.';
        }
    } else {
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
                for (const pos of positionsToClose) {
                    const priceData = botState.priceCache.get(pos.symbol);
                    const exitPrice = priceData ? priceData.price : pos.entry_price;
                    await tradingEngine.closeTrade(pos.id, exitPrice, 'Circuit Breaker');
                }
                broadcast({ type: 'POSITIONS_UPDATED' });
            }
        }
    }
};

const fetchFearAndGreedIndex = async () => {
    try {
        const response = await fetch('https://api.alternative.me/fng/?limit=1');
        if (!response.ok) throw new Error(`API returned status ${response.status}`);
        const data = await response.json();
        if (data?.data?.[0]) {
            const fng = data.data[0];
            const fngData = { value: parseInt(fng.value, 10), classification: fng.value_classification };
            botState.fearAndGreed = fngData;
            broadcast({ type: 'FEAR_AND_GREED_UPDATE', payload: fngData });
            // FIX: The function checkGlobalSafetyRules is async and must be awaited.
            await checkGlobalSafetyRules();
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

    runScannerCycle(); 
    scannerInterval = setInterval(runScannerCycle, botState.settings.SCANNER_DISCOVERY_INTERVAL_SECONDS * 1000);
    
    setInterval(() => {
        if (botState.isRunning) {
            tradingEngine.monitorAndManagePositions();
        }
    }, 1000);
    
    fetchFearAndGreedIndex();
    setInterval(fetchFearAndGreedIndex, 15 * 60 * 1000);

    connectToBinanceStreams();
    log('INFO', 'Bot started. Initializing scanner and position manager...');
};

// --- API Endpoints ---
const requireAuth = (req, res, next) => {
    if (req.session?.isAuthenticated) {
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
        if (err) return res.status(500).json({ message: 'Could not log out.' });
        res.clearCookie('connect.sid');
        res.status(204).send();
    });
});

app.get('/api/check-session', (req, res) => {
    res.json({ isAuthenticated: !!req.session?.isAuthenticated });
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
    botState.settings = { ...botState.settings, ...req.body };
    
    if (botState.tradingMode === 'VIRTUAL' && botState.settings.INITIAL_VIRTUAL_BALANCE !== oldSettings.INITIAL_VIRTUAL_BALANCE) {
        botState.balance = botState.settings.INITIAL_VIRTUAL_BALANCE;
        await setKeyValue('balance', botState.balance);
        log('INFO', `Virtual balance adjusted to: $${botState.balance}`);
        broadcast({ type: 'POSITIONS_UPDATED' });
    }

    await saveData('settings');
    realtimeAnalyzer.updateSettings(botState.settings);
    
    if (botState.settings.BINANCE_API_KEY !== oldSettings.BINANCE_API_KEY || botState.settings.BINANCE_SECRET_KEY !== oldSettings.BINANCE_SECRET_KEY) {
        log('INFO', 'Binance API keys updated. Re-initializing API client.');
        binanceApiClient = (botState.settings.BINANCE_API_KEY && botState.settings.BINANCE_SECRET_KEY)
            ? new BinanceApiClient(botState.settings.BINANCE_API_KEY, botState.settings.BINANCE_SECRET_KEY, log)
            : null;
    }
    
    if (botState.settings.SCANNER_DISCOVERY_INTERVAL_SECONDS !== oldSettings.SCANNER_DISCOVERY_INTERVAL_SECONDS) {
        log('INFO', `Scanner interval updated to ${botState.settings.SCANNER_DISCOVERY_INTERVAL_SECONDS}s.`);
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
    const augmentedPositions = botState.activePositions.map(pos => {
        const priceData = botState.priceCache.get(pos.symbol);
        const currentPrice = priceData ? priceData.price : pos.average_entry_price;
        const current_value = currentPrice * pos.quantity;
        const pnl = (pos.realized_pnl || 0) + current_value - pos.total_cost_usd;
        const initialFullPositionValue = pos.average_entry_price * pos.target_quantity;
        const pnl_pct = initialFullPositionValue > 0 ? (pnl / initialFullPositionValue) * 100 : 0;
        return { ...pos, current_price: currentPrice, pnl, pnl_pct };
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
    const pnlPcts = botState.tradeHistory.map(t => t.pnl_pct).filter(p => p != null);
    const avg_pnl_pct = pnlPcts.length > 0 ? pnlPcts.reduce((a, b) => a + b, 0) / pnlPcts.length : 0;
    res.json({ total_trades, winning_trades, losing_trades, total_pnl, win_rate, avg_pnl_pct });
});

app.get('/api/scanner', requireAuth, (req, res) => {
    res.json(botState.scannerCache);
});


// --- ACTIONS ---
app.post('/api/open-trade', requireAuth, (req, res) => {
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
        broadcast({ type: 'POSITIONS_UPDATED' });
        res.json(closedTrade);
    } else {
        res.status(500).json({ message: 'Failed to close trade on exchange. Position remains open.' });
    }
});

app.post('/api/clear-data', requireAuth, async (req, res) => {
    log('WARN', 'User initiated data clear. Resetting all trade history and balance.');
    await db.run('DELETE FROM trades');
    botState.activePositions = [];
    botState.tradeHistory = [];
    botState.balance = botState.settings.INITIAL_VIRTUAL_BALANCE;
    await setKeyValue('balance', botState.balance);
    broadcast({ type: 'POSITIONS_UPDATED' });
    res.json({ success: true });
});

// --- CONNECTION TESTS ---
app.post('/api/test-connection', requireAuth, async (req, res) => {
    const { apiKey, secretKey } = req.body;
    if (!apiKey || !secretKey) return res.status(400).json({ success: false, message: "API Key and Secret Key are required." });
    const tempApiClient = new BinanceApiClient(apiKey, secretKey, log);
    try {
        await tempApiClient.getAccountInfo();
        res.json({ success: true, message: 'Connexion à Binance et validation des clés réussies !' });
    } catch (error) {
        res.status(500).json({ success: false, message: `Échec de la connexion à Binance : ${error.message}` });
    }
});

app.get('/api/ping-binance', requireAuth, async (req, res) => {
    try {
        const startTime = Date.now();
        await fetch('https://api.binance.com/api/v3/time');
        const endTime = Date.now();
        const latency = endTime - startTime;
        res.json({ success: true, latency });
    } catch (error) {
        log('ERROR', `Binance ping failed: ${error.message}`);
        res.status(500).json({ success: false, message: 'Ping failed.' });
    }
});


// --- BOT CONTROL ---
app.get('/api/bot/status', requireAuth, (req, res) => res.json({ isRunning: botState.isRunning }));

app.post('/api/bot/start', requireAuth, async (req, res) => {
    botState.isRunning = true;
    await setKeyValue('isRunning', 'true');
    log('INFO', 'Bot has been started via API.');
    res.json({ success: true });
});

app.post('/api/bot/stop', requireAuth, async (req, res) => {
    botState.isRunning = false;
    await setKeyValue('isRunning', 'false');
    log('INFO', 'Bot has been stopped via API.');
    res.json({ success: true });
});

app.get('/api/mode', requireAuth, (req, res) => res.json({ mode: botState.tradingMode }));

app.post('/api/mode', requireAuth, async (req, res) => {
    const { mode } = req.body;
    if (!['VIRTUAL', 'REAL_PAPER', 'REAL_LIVE'].includes(mode)) {
        return res.status(400).json({ success: false, message: 'Invalid mode.' });
    }
    
    botState.tradingMode = mode;
    if (mode === 'VIRTUAL') {
        botState.balance = botState.settings.INITIAL_VIRTUAL_BALANCE;
        log('INFO', 'Switched to VIRTUAL mode. Balance reset.');
    } else {
        if (!binanceApiClient) {
             botState.tradingMode = 'VIRTUAL'; // Revert
             return res.status(400).json({ success: false, message: 'Binance API keys not set.' });
        }
        try {
            const accountInfo = await binanceApiClient.getAccountInfo();
            const usdtBalance = accountInfo.balances.find(b => b.asset === 'USDT');
            botState.balance = usdtBalance ? parseFloat(usdtBalance.free) : 0;
            log('INFO', `Switched to ${mode} mode. Real USDT balance: $${botState.balance.toFixed(2)}`);
        } catch(error) {
             botState.tradingMode = 'VIRTUAL'; // Revert
             return res.status(500).json({ success: false, message: `Failed to fetch real balance: ${error.message}` });
        }
    }
    await setKeyValue('tradingMode', botState.tradingMode);
    await setKeyValue('balance', botState.balance);
    log('INFO', `Trading mode switched to ${mode}.`);
    broadcast({ type: 'POSITIONS_UPDATED' });
    res.json({ success: true, mode: botState.tradingMode });
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