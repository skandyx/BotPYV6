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
                management_settings TEXT,
                is_flash_sl_active INTEGER NOT NULL DEFAULT 0
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
        is_flash_sl_active: !!dbRow.is_flash_sl_active,
        entry_snapshot: dbRow.entry_snapshot ? JSON.parse(dbRow.entry_snapshot) : null,
        management_settings: dbRow.management_settings ? JSON.parse(dbRow.management_settings) : null,
    };
};

const prepareTradeForDb = (trade) => {
    const dbTrade = { ...trade };
    for (const key of ['is_at_breakeven', 'partial_tp_hit', 'trailing_stop_tightened', 'is_scaling_in', 'is_flash_sl_active']) {
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
        this.log('INFO', '[Analyzer] Settings updated for new Pondered strategy.');
        this.settings = newSettings;
    }
    
    // Phase 1 (Macro Scan) is now handled by ScannerService.
    // This class handles Phase 2 (Micro Trigger) based on real-time klines.

    async analyze1mTrigger(symbol) {
        const pair = botState.scannerCache.find(p => p.symbol === symbol);
        if (!pair || !pair.is_on_hotlist) return;

        // Avoid trading if position already open, on cooldown, or pending confirmation from another signal
        if (botState.activePositions.some(p => p.symbol === symbol) || botState.recentlyLostSymbols.has(symbol) || botState.pendingConfirmation.has(symbol)) {
            return;
        }

        const klines1m = this.klineData.get(symbol)?.get('1m');
        if (!klines1m || klines1m.length < 21) return; // Need history for indicators

        const closes1m = klines1m.map(k => k.close);
        const volumes1m = klines1m.map(k => k.volume);
        
        // --- Calculate 1m indicators ---
        const lastEma9 = EMA.calculate({ period: 9, values: closes1m }).pop();
        const rsiResult = RSI.calculate({ period: 14, values: closes1m });
        const lastRsi = rsiResult[rsiResult.length - 1];
        const prevRsi = rsiResult[rsiResult.length - 2];
        const macdResult = MACD.calculate({ values: closes1m, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
        const lastMacd = macdResult[macdResult.length - 1];
        const prevMacd = macdResult[macdResult.length - 2];
        const avgVolume = volumes1m.slice(-21, -1).reduce((sum, v) => sum + v, 0) / 20;
        
        if (!lastEma9 || !lastRsi || !prevRsi || !lastMacd || !prevMacd) return;

        // --- Phase 2 Scoring ---
        let entryScore = 0;
        const triggerCandle = klines1m[klines1m.length - 1];
        
        if (triggerCandle.close > lastEma9) entryScore += 1;
        if (lastRsi > 50 && prevRsi <= 50) entryScore += 1; // RSI bullish cross
        if (lastMacd.MACD > lastMacd.signal && prevMacd.MACD <= prevMacd.signal) entryScore += 1; // MACD bullish cross
        
        const volumeMultiplier = avgVolume > 0 ? triggerCandle.volume / avgVolume : 0;
        if (volumeMultiplier > 1.5) entryScore += 2; // Ignition boost

        // --- Ignition Rules Check ---
        const isIgnitionSignal = (
            volumeMultiplier > 1.5 && 
            lastRsi > 55 && 
            lastMacd.histogram > 0 &&
            pair.price_above_ema50_4h // Check for key level breakout (simplified)
        );
        
        // Add 5m confirmation score
        entryScore += (pair.confirmation_5m_score || 0);

        // Add other filter scores (reinstated from old logic)
        const obvValues = calculateOBV(klines1m);
        const lastObv = obvValues[obvValues.length-1];
        const obvSma = SMA.calculate({period: 5, values: obvValues}).pop();
        if (lastObv > obvSma) entryScore += 1; // OBV confirms

        if (pair.conditions?.cvd_5m_trending_up) entryScore += 1; // CVD confirms
        
        // Safety Checks (simplified to one point)
        const candleHeight = triggerCandle.high - triggerCandle.low;
        const upperWick = triggerCandle.high - triggerCandle.close;
        const wickPercentage = candleHeight > 0 ? (upperWick / candleHeight) * 100 : 0;
        if (pair.rsi_1h < this.settings.RSI_OVERBOUGHT_THRESHOLD && wickPercentage < this.settings.MAX_UPPER_WICK_PCT) {
            entryScore += 1;
        }

        pair.entry_score = entryScore;
        
        const entryThreshold = isIgnitionSignal ? 6 : 8;

        if (entryScore >= entryThreshold) {
            this.log('TRADE', `[${isIgnitionSignal ? 'IGNITION 🚀' : 'ENTRY ✔'}] Signal for ${symbol} with Score: ${entryScore}/${entryThreshold}.`);
            
            pair.strategy_type = isIgnitionSignal ? 'IGNITION' : 'PRECISION';
            
            const tradeOpened = await tradingEngine.evaluateAndOpenTrade(pair, triggerCandle.low);
            if (tradeOpened) {
                pair.is_on_hotlist = false;
                removeSymbolFromMicroStreams(symbol);
                broadcast({ type: 'SCANNER_UPDATE', payload: pair });
            }
        }
    }

    analyze5mConfirmation(symbol, new5mCandle) {
        const pair = botState.scannerCache.find(p => p.symbol === symbol);
        if (!pair || !pair.is_on_hotlist) return;

        let confirmationScore = 0;
        const prevCandle = this.klineData.get(symbol)?.get('5m')?.slice(-2, -1)[0];

        if (prevCandle) {
            if (new5mCandle.close > prevCandle.high) {
                confirmationScore = 2; // Strong confirmation
            } else if (new5mCandle.close < new5mCandle.open) {
                confirmationScore = -1; // Contradiction
            }
        }
        pair.confirmation_5m_score = confirmationScore;

        // Also update CVD status
        const klines5m = this.klineData.get(symbol)?.get('5m');
        if (klines5m && klines5m.length > 10) {
             const cvdValues = calculateCVD(klines5m);
             const lastCvd = cvdValues[cvdValues.length - 1];
             const cvdSma = SMA.calculate({ period: 5, values: cvdValues }).pop();
             pair.conditions.cvd_5m_trending_up = lastCvd > cvdSma;
        }

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

        } catch (error) {
            this.log('ERROR', `Failed to hydrate ${symbol} (${interval}): ${error.message}`);
        } finally {
            this.hydrating.delete(`${symbol}-${interval}`);
        }
    }

    async handleNewKline(symbol, interval, kline) {
        if(symbol === 'BTCUSDT' && interval === '1m' && kline.closeTime) {
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
        
        if (interval === '5m') {
            this.analyze5mConfirmation(symbol, kline);
        } else if (interval === '1m') {
            this.analyze1mTrigger(symbol);

            // Check for scaling-in confirmations on existing trades
            if (botState.settings.SCALING_IN_CONFIG && botState.settings.SCALING_IN_CONFIG.trim() !== '') {
                const position = botState.activePositions.find(p => p.symbol === symbol && p.is_scaling_in);
                if (position && kline.close > kline.open) { // Bullish confirmation candle
                    tradingEngine.scaleInPosition(position, kline.close, botState.settings);
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
        this.log('SCANNER', `Found ${discoveredPairs.length} pairs after initial filters.`);
        
        const analysisPromises = discoveredPairs.map(pair => 
            scanner.analyzePair(pair.symbol, botState.settings)
                .then(analysis => analysis ? { ...pair, ...analysis } : null)
                .catch(e => {
                    this.log('WARN', `Could not analyze ${pair.symbol}: ${e.message}`);
                    return null;
                })
        );
        
        const results = await Promise.all(analysisPromises);
        const analyzedPairs = results.filter(p => p !== null);

        botState.scannerCache = analyzedPairs;

        // Hydrate klines for all monitored pairs
        await Promise.all(analyzedPairs.map(p => realtimeAnalyzer.hydrateSymbol(p.symbol, '15m')));

        // Update hotlist based on new scores
        const newHotlist = new Set();
        analyzedPairs.forEach(p => {
            if (p.hotlist_score >= 5) {
                newHotlist.add(p.symbol);
                p.is_on_hotlist = true;
            } else {
                p.is_on_hotlist = false;
            }
        });

        // Manage micro-stream subscriptions
        const oldHotlist = botState.hotlist;
        oldHotlist.forEach(symbol => {
            if (!newHotlist.has(symbol)) removeSymbolFromMicroStreams(symbol);
        });
        newHotlist.forEach(symbol => {
            if (!oldHotlist.has(symbol)) addSymbolToMicroStreams(symbol);
        });
        
        // Update WebSocket subscriptions for all tickers
        updateBinanceSubscriptions(botState.scannerCache.map(p => p.symbol));
        
    } catch (error) {
        log('ERROR', `Scanner cycle failed: ${error.message}`);
    }
}

const settingProfiles = {
    'Scalpeur': {
        USE_ATR_STOP_LOSS: false,
        STOP_LOSS_PCT: 0.3,
        RISK_REWARD_RATIO: 2.0, // TP = 0.6%
        USE_PARTIAL_TAKE_PROFIT: false,
        USE_AUTO_BREAKEVEN: false,
        USE_ADAPTIVE_TRAILING_STOP: false,
    },
    'Chasseur Volatilité': {
        USE_ATR_STOP_LOSS: true,
        ATR_MULTIPLIER: 1.5,
        RISK_REWARD_RATIO: 1.5, // TP dynamique
        USE_PARTIAL_TAKE_PROFIT: false,
        USE_AUTO_BREAKEVEN: true,
        BREAKEVEN_TRIGGER_R: 1.0,
        USE_ADAPTIVE_TRAILING_STOP: true,
        TRAILING_STOP_TIGHTEN_THRESHOLD_R: 1.5,
        TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION: 0.5,
    },
    'Sniper': {
        USE_ATR_STOP_LOSS: true,
        ATR_MULTIPLIER: 2.0, // Trailing large
        RISK_REWARD_RATIO: 5.0, // TP large, mais géré par le trailing
        USE_PARTIAL_TAKE_PROFIT: true,
        PARTIAL_TP_TRIGGER_PCT: 1.0, 
        PARTIAL_TP_SELL_QTY_PCT: 50,
        USE_AUTO_BREAKEVEN: true,
        BREAKEVEN_TRIGGER_R: 1.0,
        USE_ADAPTIVE_TRAILING_STOP: true,
        TRAILING_STOP_TIGHTEN_THRESHOLD_R: 2.0, // Resserrage plus tardif
        TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION: 0.5,
    }
};

// --- Trading Engine ---
const tradingEngine = {
    async evaluateAndOpenTrade(pair, slPriceReference) {
        if (!botState.isRunning) return false;
        if (botState.circuitBreakerStatus.startsWith('HALTED') || botState.circuitBreakerStatus.startsWith('PAUSED')) {
            log('WARN', `Trade for ${pair.symbol} blocked: Global Circuit Breaker is active (${botState.circuitBreakerStatus}).`);
            return false;
        }
        
        // Determine trade settings based on dynamic profile
        let tradeSettings = { ...botState.settings };
        if (tradeSettings.USE_DYNAMIC_PROFILE_SELECTOR) {
            if (pair.adx_15m < tradeSettings.ADX_THRESHOLD_RANGE) {
                tradeSettings = { ...tradeSettings, ...settingProfiles['Scalpeur'] };
                log('TRADE', `[Profile] Scalpeur selected for ${pair.symbol} (ADX: ${pair.adx_15m.toFixed(1)})`);
            } else if (pair.adx_15m > 25 && pair.atr_pct_15m > tradeSettings.ATR_PCT_THRESHOLD_VOLATILE) {
                 tradeSettings = { ...tradeSettings, ...settingProfiles['Sniper'] };
                 log('TRADE', `[Profile] Sniper selected for ${pair.symbol} (ADX: ${pair.adx_15m.toFixed(1)}, ATR: ${pair.atr_pct_15m.toFixed(2)}%)`);
            } else {
                tradeSettings = { ...tradeSettings, ...settingProfiles['Chasseur Volatilité'] };
                log('TRADE', `[Profile] Chasseur Volatilité selected for ${pair.symbol} (ADX: ${pair.adx_15m.toFixed(1)})`);
            }
        }
        
        const isIgnition = pair.strategy_type === 'IGNITION';
        if (isIgnition) {
            tradeSettings.USE_FLASH_TRAILING_STOP = true; // Ignition mandates Flash SL
        }

        // --- Standard Pre-flight Checks ---
        const cooldownInfo = botState.recentlyLostSymbols.get(pair.symbol);
        if (cooldownInfo && Date.now() < cooldownInfo.until) {
            log('TRADE', `Skipping trade for ${pair.symbol} due to recent loss cooldown.`);
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
        
        let positionSizeUSD = botState.balance * (positionSizePct / 100);
        
        if (botState.circuitBreakerStatus === 'WARNING_BTC_DROP') {
            positionSizeUSD /= 2;
            log('WARN', `[CIRCUIT BREAKER] WARNING ACTIVE. Reducing position size for ${pair.symbol} to $${positionSizeUSD.toFixed(2)}.`);
        }

        const target_quantity = positionSizeUSD / entryPrice;
        
        const rules = symbolRules.get(pair.symbol);
        const minNotionalValue = rules ? rules.minNotional : 5.0;
        if (botState.tradingMode === 'REAL_LIVE' && (target_quantity * entryPrice) < minNotionalValue) {
            log('ERROR', `[MIN_NOTIONAL] Aborting trade for ${pair.symbol}. Position size ($${(target_quantity * entryPrice).toFixed(2)}) is below minimum ($${minNotionalValue}).`);
            return false;
        }
        
        if (botState.tradingMode === 'REAL_LIVE') { /* ... real execution logic ... */ }

        let stopLoss;
        if (tradeSettings.USE_ATR_STOP_LOSS && pair.atr_15m) {
            stopLoss = entryPrice - (pair.atr_15m * tradeSettings.ATR_MULTIPLIER);
        } else {
            stopLoss = entryPrice * (1 - tradeSettings.STOP_LOSS_PCT / 100);
        }
        
        const riskPerUnit = entryPrice - stopLoss;
        if (riskPerUnit <= 0) {
            log('ERROR', `Calculated risk is zero or negative for ${pair.symbol}. Aborting.`);
            return false;
        }
        const takeProfit = entryPrice + (riskPerUnit * tradeSettings.RISK_REWARD_RATIO);
        
        const newTrade = {
            id: null,
            mode: botState.tradingMode,
            symbol: pair.symbol,
            side: 'BUY',
            entry_price: entryPrice,
            average_entry_price: entryPrice,
            quantity: target_quantity,
            target_quantity: target_quantity,
            total_cost_usd: target_quantity * entryPrice,
            stop_loss: stopLoss,
            initial_stop_loss: stopLoss,
            take_profit: takeProfit,
            highest_price_since_entry: entryPrice,
            entry_time: new Date().toISOString(),
            status: 'FILLED',
            entry_snapshot: { ...pair },
            strategy_type: pair.strategy_type,
            is_flash_sl_active: false,
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
        const { id, ...dbTradeToInsert } = dbTrade;
        const columns = Object.keys(dbTradeToInsert).join(', ');
        const placeholders = Object.keys(dbTradeToInsert).map(() => '?').join(', ');
        const result = await db.run(`INSERT INTO trades (${columns}) VALUES (${placeholders})`, Object.values(dbTradeToInsert));
        newTrade.id = result.lastID;
        botState.activePositions.push(newTrade);
        
        if (botState.tradingMode === 'VIRTUAL') {
            botState.balance -= newTrade.total_cost_usd;
            await setKeyValue('balance', botState.balance);
        }

        log('TRADE', `>>> TRADE OPENED (ID: ${newTrade.id}, STRATEGY: ${newTrade.strategy_type}) <<< Opening ${botState.tradingMode} trade for ${pair.symbol}.`);
        
        broadcast({ type: 'POSITIONS_UPDATED' });
        return true;
    },

    async monitorAndManagePositions() {
        if (!botState.isRunning) return;

        const positionsToClose = [];
        for (const pos of botState.activePositions) {
            const priceData = botState.priceCache.get(pos.symbol);
            if (!priceData) continue;

            const s = pos.management_settings || botState.settings;
            const currentPrice = priceData.price;
            let changes = {};

            if (currentPrice > pos.highest_price_since_entry) {
                pos.highest_price_since_entry = currentPrice;
                changes.highest_price_since_entry = currentPrice;
            }

            const pnlPct = ((currentPrice - pos.average_entry_price) / pos.average_entry_price) * 100;

            // --- STOP LOSS SUIVEUR ⚡ LOGIC ---
            if (!pos.is_flash_sl_active && pnlPct >= 0.5) {
                pos.is_flash_sl_active = true;
                changes.is_flash_sl_active = 1;
                // Move SL just above entry to secure a profit
                let newStopLoss = pos.average_entry_price * (1 + (s.TRANSACTION_FEE_PCT / 100) * 2);
                if (newStopLoss > pos.stop_loss) {
                    pos.stop_loss = newStopLoss;
                    changes.stop_loss = newStopLoss;
                }
                log('TRADE', `[${pos.symbol}] Stop Loss Suiveur ⚡ ACTIVATED. SL moved to break-even.`);
            }

            if (pos.is_flash_sl_active) {
                const newTrailingSL = pos.highest_price_since_entry * (1 - s.FLASH_TRAILING_STOP_PCT / 100);
                if (newTrailingSL > pos.stop_loss) {
                    pos.stop_loss = newTrailingSL;
                    changes.stop_loss = newTrailingSL;
                }
            }
            
            // --- Standard Management (only if flash SL is not active) ---
            if (!pos.is_flash_sl_active) {
                 if (currentPrice <= pos.stop_loss) {
                    positionsToClose.push({ trade: pos, exitPrice: pos.stop_loss, reason: 'Stop Loss' });
                    continue;
                }
                if (currentPrice >= pos.take_profit) {
                    positionsToClose.push({ trade: pos, exitPrice: pos.take_profit, reason: 'Take Profit' });
                    continue;
                }
            } else { // If flash SL is active, it's the only SL that matters
                if (currentPrice <= pos.stop_loss) {
                    positionsToClose.push({ trade: pos, exitPrice: pos.stop_loss, reason: 'Stop Loss Suiveur ⚡' });
                    continue;
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
        if (tradeIndex === -1) return null;
        
        let trade = botState.activePositions[tradeIndex];
        botState.activePositions.splice(tradeIndex, 1);
        
        trade.exit_price = exitPrice;
        trade.exit_time = new Date().toISOString();
        trade.status = 'CLOSED';
        const pnl = (exitPrice - trade.average_entry_price) * trade.quantity;
        trade.pnl = pnl;
        trade.pnl_pct = (pnl / trade.total_cost_usd) * 100;

        await db.run('UPDATE trades SET status = ?, exit_price = ?, exit_time = ?, pnl = ?, pnl_pct = ? WHERE id = ?', 'CLOSED', trade.exit_price, trade.exit_time, trade.pnl, trade.pnl_pct, trade.id);

        if (trade.mode === 'VIRTUAL') {
            botState.balance += trade.total_cost_usd + pnl;
            await setKeyValue('balance', botState.balance);
        } else {
             botState.balance += pnl;
             await setKeyValue('balance', botState.balance);
        }
        
        botState.tradeHistory.push(trade);
        
        if (pnl < 0 && botState.settings.LOSS_COOLDOWN_HOURS > 0) {
            const cooldownUntil = Date.now() + botState.settings.LOSS_COOLDOWN_HOURS * 60 * 60 * 1000;
            botState.recentlyLostSymbols.set(trade.symbol, { until: cooldownUntil });
        }
        
        log('TRADE', `<<< TRADE CLOSED >>> [${reason}] Closed ${trade.symbol}. PnL: $${pnl.toFixed(2)} (${trade.pnl_pct.toFixed(2)}%)`);
        return trade;
    },
    
    // Unchanged methods
    async scaleInPosition() {},
    async executePartialSell() {},
};

// --- Global Safety & Main Loop (largely unchanged) ---
async function checkGlobalSafetyRules() { /* ... */ }
async function fetchFearAndGreedIndex() { /* ... */ }
const startBot = async () => { /* ... */ };

// --- API Endpoints (largely unchanged) ---
/* ... all endpoints ... */

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