import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';
import { SMA, ADX, MACD, RSI, EMA } from 'technicalindicators';

const FIAT_CURRENCIES = ['EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'HKD', 'NZD', 'SEK', 'KRW', 'SGD', 'NOK', 'MXN', 'INR', 'RUB', 'ZAR', 'TRY', 'BRL'];

export class ScannerService {
    constructor(log, klineDataDir) {
        this.log = log;
        this.klineDataDir = klineDataDir;
        this.cache = new Map(); // Cache in-memory pour les analyses de fond
        this.cacheTTL = 60 * 60 * 1000; // 1 heure
    }

    async runScan(settings) {
        this.log('SCANNER', 'Starting new discovery cycle for breakout strategy...');
        try {
            const binancePairs = await this.discoverAndFilterPairsFromBinance(settings);
            if (binancePairs.length === 0) {
                this.log('WARN', 'No pairs found meeting volume/exclusion criteria.');
                return [];
            }
            this.log('SCANNER', `Found ${binancePairs.length} pairs after initial filters.`);

            const analysisPromises = binancePairs.map(pair => this.analyzePair(pair.symbol, settings)
                .then(analysis => analysis ? { ...pair, ...analysis } : null)
                .catch(e => {
                    this.log('WARN', `Could not analyze ${pair.symbol}: ${e.message}`);
                    return null;
                })
            );

            const results = await Promise.all(analysisPromises);
            const analyzedPairs = results.filter(p => p !== null);
            
            this.log('SCANNER', `Discovery finished. ${analyzedPairs.length} pairs passed long-term analysis and are being monitored.`);
            return analyzedPairs;

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
        this.log('SCANNER', `Performing long-term analysis for ${symbol}...`);

        // --- Fetch Data ---
        const klines4h = await this.fetchKlinesFromBinance(symbol, '4h', 0, 100);
        if (klines4h.length < 50) return null;
        
        const klines1h = await this.fetchKlinesFromBinance(symbol, '1h', 0, 100);
        if (klines1h.length < 21) return null;

        // --- 4h ANALYSIS (MACRO TREND) ---
        const closes4h = klines4h.map(k => parseFloat(k[4]));
        const highs4h = klines4h.map(k => parseFloat(k[2]));
        const lows4h = klines4h.map(k => parseFloat(k[3]));
        
        const lastClose4h = closes4h[closes4h.length - 1];
        
        // Condition 1: Price above EMA50
        const lastEma50_4h = EMA.calculate({ period: 50, values: closes4h }).pop();
        const price_above_ema50_4h = lastClose4h > lastEma50_4h;
        
        // Condition 2: RSI for Momentum
        const rsi4h = RSI.calculate({ period: 14, values: closes4h }).pop();
        const hasMomentum = rsi4h > 50;
        
        // Condition 3: ADX for Trend Strength
        const adxResult = ADX.calculate({ high: highs4h, low: lows4h, close: closes4h, period: 14 }).pop();
        const isTrending = adxResult && adxResult.adx > 20;

        // Enhanced Trend Score Calculation
        let trend_score = 0;
        if (price_above_ema50_4h) trend_score += 40; // Base score for being in the right direction
        if (hasMomentum) trend_score += 30;         // Bonus for momentum
        if (isTrending) trend_score += 30;          // Bonus for trend strength

        // --- 1h ANALYSIS (Safety Filter) ---
        const closes1h = klines1h.map(k => parseFloat(k[4]));
        const rsi_1h = RSI.calculate({ values: closes1h, period: 14 }).pop();

        const analysisData = {
            price_above_ema50_4h,
            trend_score,
            rsi_1h,
            // Defaults that will be updated by the real-time analyzer
            priceDirection: 'neutral',
            score: 'HOLD',
            score_value: 50,
            is_in_squeeze_15m: false,
            adx_15m: undefined,
            atr_pct_15m: undefined,
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