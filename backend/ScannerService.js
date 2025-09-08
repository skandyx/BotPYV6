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
        const klines4h = await this.fetchKlinesFromBinance(symbol, '4h', 0, 201);
        if (klines4h.length < 200) return null;
        
        const klines1h = await this.fetchKlinesFromBinance(symbol, '1h', 0, 100);
        if (klines1h.length < 21) return null;

        // --- 4h ANALYSIS (MACRO TREND SCORE) ---
        const closes4h = klines4h.map(k => parseFloat(k[4]));
        let trend4h_score = 0;
        const lastClose4h = closes4h[closes4h.length-1];
        
        const ema200_4h = EMA.calculate({ period: 200, values: closes4h }).pop();
        if(lastClose4h > ema200_4h) trend4h_score += 1; else trend4h_score -=1;

        const rsi_4h = RSI.calculate({ period: 14, values: closes4h }).pop();
        if(rsi_4h > 55) trend4h_score += 0.5; else if(rsi_4h < 45) trend4h_score -= 0.5;

        const macd_4h_input = { values: closes4h, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, simpleMAOscillator: false, simpleMASignal: false };
        const macd_4h = MACD.calculate(macd_4h_input);
        const last_macd_4h = macd_4h[macd_4h.length-1];
        if(last_macd_4h && last_macd_4h.MACD > last_macd_4h.signal) trend4h_score += 0.5; else if(last_macd_4h && last_macd_4h.MACD < last_macd_4h.signal) trend4h_score -= 0.5;
        
        trend4h_score = Math.max(-2, Math.min(2, trend4h_score));


        // --- 1h ANALYSIS (Safety Filter) ---
        const closes1h = klines1h.map(k => parseFloat(k[4]));
        const rsi_1h = RSI.calculate({ values: closes1h, period: 14 }).pop();

        const analysisData = {
            price_above_ema50_4h: lastClose4h > EMA.calculate({ period: 50, values: closes4h }).pop(), // Keep for legacy display
            trend_score: (trend4h_score + 2) * 25, // Normalize to 0-100 for UI
            rsi_1h,
            conditions: {
                trend4h_score,
            },
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