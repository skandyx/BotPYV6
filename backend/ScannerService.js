import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';
import { SMA, ADX, MACD, RSI, EMA } from 'technicalindicators';

const FIAT_CURRENCIES = ['EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'HKD', 'NZD', 'SEK', 'KRW', 'SGD', 'NOK', 'MXN', 'INR', 'RUB', 'ZAR', 'TRY', 'BRL'];

const calculateTrendScore = (klines, log) => {
    if (!klines || klines.length < 200) return 0;
    
    const closes = klines.map(k => parseFloat(k[4]));
    const lastClose = closes[closes.length - 1];

    const ema50 = EMA.calculate({ period: 50, values: closes }).pop();
    const ema200 = EMA.calculate({ period: 200, values: closes }).pop();
    const rsi = RSI.calculate({ period: 14, values: closes }).pop();
    const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }).pop();

    if (!ema50 || !ema200 || !rsi || !macd) return 0;

    let score = 0;
    if (lastClose > ema50) score += 0.5; else score -= 0.5;
    if (lastClose > ema200) score += 0.5; else score -= 0.5;
    if (ema50 > ema200) score += 0.5; else score -= 0.5;
    if (rsi > 50) score += 0.25; else if (rsi < 40) score -= 0.25;
    if (macd.histogram > 0) score += 0.25; else score -= 0.25;

    // Scale score from [-2, 2]
    return Math.min(2, Math.max(-2, score));
};


export class ScannerService {
    constructor(log, klineDataDir) {
        this.log = log;
        this.klineDataDir = klineDataDir;
        this.cache = new Map(); // Cache in-memory pour les analyses de fond
        this.cacheTTL = 60 * 60 * 1000; // 1 heure
    }

    async runScan(settings) {
        this.log('SCANNER', 'Starting new discovery cycle for Pondered strategy...');
        try {
            const binancePairs = await this.discoverAndFilterPairsFromBinance(settings);
            if (binancePairs.length === 0) {
                this.log('WARN', 'No pairs found meeting volume/exclusion criteria.');
                return [];
            }
            this.log('SCANNER', `Found ${binancePairs.length} pairs after initial filters.`);

            return binancePairs;

        } catch (error) {
            this.log('ERROR', `Discovery cycle failed: ${error.message}.`);
            throw error;
        }
    }

    async discoverAndFilterPairsFromBinance(settings) {
        this.log('BINANCE_API', 'Fetching all 24hr ticker data from Binance...');
        try {
            const response = await fetch('https://api.binance.com/api/v3/ticker/24hr');
            if (!response.ok) throw new Error(`Binance API error! status: ${response.status}`);
            const allTickers = await response.json();
            if (!Array.isArray(allTickers)) throw new Error('Binance API did not return an array.');

            const excluded = settings.EXCLUDED_PAIRS.split(',').map(p => p.trim());
            const containsFiat = (symbol) => {
                const base = symbol.replace('USDT', '');
                return FIAT_CURRENCIES.includes(base);
            };

            return allTickers
                .filter(ticker => 
                    ticker.symbol.endsWith('USDT') &&
                    !containsFiat(ticker.symbol) &&
                    parseFloat(ticker.quoteVolume) > settings.MIN_VOLUME_USD &&
                    !excluded.includes(ticker.symbol)
                )
                .map(ticker => ({
                    symbol: ticker.symbol,
                    volume: parseFloat(ticker.quoteVolume),
                    price: parseFloat(ticker.lastPrice),
                }));
        } catch (error) {
            this.log('ERROR', `Failed to discover pairs from Binance: ${error.message}`);
            throw error;
        }
    }

    async analyzePair(symbol, settings) {
        const cached = this.cache.get(symbol);
        if (cached && cached.timestamp > Date.now() - this.cacheTTL) {
            return cached.data;
        }
        this.log('SCANNER', `[Phase 1] Analyzing macro trend for ${symbol}...`);

        // --- Fetch Data ---
        const klines4h = await this.fetchKlinesFromBinance(symbol, '4h', 0, 201);
        if (klines4h.length < 200) return null;
        
        const klines15m = await this.fetchKlinesFromBinance(symbol, '15m', 0, 201);
        if (klines15m.length < 200) return null;

        const klines1h = await this.fetchKlinesFromBinance(symbol, '1h', 0, 100);
         if (klines1h.length < 21) return null;

        // --- Phase 1 Scoring ---
        const trend_score_4h = calculateTrendScore(klines4h, this.log);
        const trend_score_15m = calculateTrendScore(klines15m, this.log);

        // Volume Score
        const volumes15m = klines15m.map(k => parseFloat(k[5]));
        const currentVolume = volumes15m[volumes15m.length - 1];
        const avgVolume = volumes15m.slice(-21, -1).reduce((sum, v) => sum + v, 0) / 20;
        const volumeMultiplier = avgVolume > 0 ? currentVolume / avgVolume : 0;
        
        let volume_score = 0;
        if (volumeMultiplier >= 2) volume_score = 3;
        else if (volumeMultiplier >= 1.5) volume_score = 2;
        else if (volumeMultiplier >= 1.3) volume_score = 1;

        // Ignoring BTC correlation for now (+1)
        const hotlist_score = trend_score_4h + trend_score_15m + volume_score;
        
        // --- Other necessary indicators ---
        const closes1h = klines1h.map(k => parseFloat(k[4]));
        const rsi_1h = RSI.calculate({ values: closes1h, period: 14 }).pop();

        const closes15m = klines15m.map(k => parseFloat(k[4]));
        const highs15m = klines15m.map(k => parseFloat(k[2]));
        const lows15m = klines15m.map(k => parseFloat(k[3]));

        const atr_15m = ATR.calculate({ high: highs15m, low: lows15m, close: closes15m, period: 14 }).pop();
        const adx_15m = ADX.calculate({ high: highs15m, low: lows15m, close: closes15m, period: 14 }).pop()?.adx;
        const lastClose15m = closes15m[closes15m.length - 1];

        const analysisData = {
            hotlist_score,
            trend_score_4h,
            trend_score_15m,
            volume_score,
            rsi_1h,
            atr_15m,
            adx_15m,
            atr_pct_15m: atr_15m ? (atr_15m / lastClose15m) * 100 : 0,
            price_above_ema50_4h: calculateTrendScore(klines4h) > 0, // Simplified for legacy UI
            // Defaults that will be updated by the real-time analyzer
            priceDirection: 'neutral',
            score: 'HOLD',
            is_on_hotlist: hotlist_score >= 5,
            entry_score: 0,
            confirmation_5m_score: 0,
            conditions: {}, // Keep for compatibility, new logic is score-based
        };

        this.cache.set(symbol, { timestamp: Date.now(), data: analysisData });
        return analysisData;
    }

    async fetchKlinesFromBinance(symbol, interval, startTime = 0, limit = 201) {
        let url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        if (startTime > 0) url += `&startTime=${startTime + 1}`;
        
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Failed to fetch klines for ${symbol} (${interval}). Status: ${response.status}`);
            const klines = await response.json();
            if (!Array.isArray(klines)) throw new Error(`Binance klines response for ${symbol} is not an array.`);
            return klines;
        } catch (error) {
            this.log('WARN', `Could not fetch klines for ${symbol} (${interval}): ${error.message}`);
            return [];
        }
    }
}