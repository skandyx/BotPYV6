export enum TradingMode {
  VIRTUAL = "VIRTUAL",
  REAL_PAPER = "REAL_PAPER",
  REAL_LIVE = "REAL_LIVE"
}

export enum OrderSide {
  BUY = "BUY",
  SELL = "SELL",
}

export enum OrderStatus {
  PENDING = "PENDING",
  FILLED = "FILLED",
  CANCELLED = "CANCELLED",
  CLOSED = "CLOSED",
}

export enum WebSocketStatus {
    CONNECTING = "CONNECTING",
    CONNECTED = "CONNECTED",
    DISCONNECTED = "DISCONNECTED",
}

export type CircuitBreakerStatus = 'NONE' | 'WARNING_BTC_DROP' | 'HALTED_BTC_DROP' | 'HALTED_DRAWDOWN' | 'PAUSED_LOSS_STREAK' | 'PAUSED_EXTREME_SENTIMENT';

export interface FearAndGreed {
    value: number;
    classification: string;
}

export type StrategyType = 'PRECISION' | 'MOMENTUM' | 'IGNITION';

export interface Trade {
  id: number;
  mode: TradingMode;
  symbol: string;
  side: OrderSide;
  entry_price: number; // For display, the first entry price
  average_entry_price: number; // For PnL calculation
  current_price?: number;
  priceDirection?: 'up' | 'down' | 'neutral';
  exit_price?: number;
  quantity: number; // Current quantity held
  target_quantity: number; // Final planned quantity
  initial_quantity?: number; // For tracking partial sells
  stop_loss: number;
  initial_stop_loss?: number; // For adaptive R-based trailing stop
  take_profit: number;
  highest_price_since_entry: number; // For Trailing Stop Loss
  entry_time: string;
  exit_time?: string;
  pnl?: number;
  pnl_pct?: number;
  status: OrderStatus;
  initial_risk_usd?: number; // The initial $ amount at risk
  is_at_breakeven?: boolean;
  partial_tp_hit?: boolean;
  realized_pnl?: number; // For tracking profit from partial sells
  entry_snapshot?: ScannedPair; // Capture scanner state at entry
  trailing_stop_tightened?: boolean; // For adaptive trailing stop logic
  total_cost_usd: number;
  is_scaling_in?: boolean;
  current_entry_count?: number;
  total_entries?: number;
  scaling_in_percents?: number[]; // For flexible scaling in
  strategy_type?: StrategyType; // New: Which strategy triggered the trade

  // Management settings snapshotted at trade entry
  management_settings?: {
      USE_AUTO_BREAKEVEN: boolean;
      BREAKEVEN_TRIGGER_R: number;
      ADJUST_BREAKEVEN_FOR_FEES: boolean;
      TRANSACTION_FEE_PCT: number;
      USE_ADAPTIVE_TRAILING_STOP: boolean;
      ATR_MULTIPLIER: number;
      TRAILING_STOP_TIGHTEN_THRESHOLD_R: number;
      TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION: number;
      USE_FLASH_TRAILING_STOP: boolean;
      FLASH_TRAILING_STOP_PCT: number;
      USE_PARTIAL_TAKE_PROFIT: boolean;
      PARTIAL_TP_TRIGGER_PCT: number;
      PARTIAL_TP_SELL_QTY_PCT: number;
  };
}

export interface StrategyConditions {
    trend: boolean;
    squeeze: boolean;
    breakout: boolean;
    volume: boolean;
    safety: boolean; // 1h RSI
    structure?: boolean;
    obv?: boolean; // 1m OBV
    rsi_mtf?: boolean; // New: 15m RSI safety check
    cvd_5m_trending_up?: boolean; // New: 5m Cumulative Volume Delta
    // --- Momentum Strategy Specific ---
    momentum_impulse?: boolean; // 15m impulse candle
    momentum_confirmation?: boolean; // 5m follow-through
}

export interface ScannedPair {
    symbol: string;
    volume: number;
    price: number;
    priceDirection: 'up' | 'down' | 'neutral';
    
    // --- Core Strategy Indicators ---
    price_above_ema50_4h?: boolean; // Master trend filter
    rsi_1h?: number; // Safety filter (anti-overheating)
    rsi_15m?: number; // New: MTF safety filter
    bollinger_bands_15m?: { upper: number; middle: number; lower: number; width_pct: number; }; // Preparation/Trigger
    is_in_squeeze_15m?: boolean; // Preparation
    volume_20_period_avg_15m?: number; // Confirmation
    atr_15m?: number; // For ATR Stop Loss calculation
    adx_15m?: number; // For dynamic profile selection (trend strength)
    atr_pct_15m?: number; // For dynamic profile selection (volatility)
    
    // --- Realtime Calculated Fields ---
    score: 'STRONG BUY' | 'BUY' | 'HOLD' | 'COOLDOWN' | 'COMPRESSION' | 'FAKE_BREAKOUT' | 'PENDING_CONFIRMATION' | 'MOMENTUM_BUY';
    score_value?: number; // Numerical representation of the score
    trend_score?: number; // Nuanced score of trend strength (0-100)
    conditions?: StrategyConditions;
    conditions_met_count?: number; // From 0 to 8
    is_on_hotlist?: boolean; // New: True if conditions are met for 1m precision entry
    strategy_type?: StrategyType; // New: Which strategy is flagging this pair
}


export interface PerformanceStats {
    total_trades: number;
    winning_trades: number;
    losing_trades: number;
    total_pnl: number;
    avg_pnl_pct: number;
    win_rate: number;
}

export interface BotStatus {
    mode: TradingMode;
    balance: number;
    positions: number;
    monitored_pairs: number;
    top_pairs: string[];
    max_open_positions: number;
}

export interface LogEntry {
    timestamp: string;
    level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE' | 'WEBSOCKET' | 'SCANNER' | 'BINANCE_API' | 'BINANCE_WS' | 'API_CLIENT';
    message: string;
}

export const LOG_LEVELS: Readonly<Array<LogEntry['level']>> = ['INFO', 'API_CLIENT', 'WARN', 'ERROR', 'TRADE', 'WEBSOCKET', 'SCANNER', 'BINANCE_API', 'BINANCE_WS'];
export type LogTab = 'ALL' | LogEntry['level'];


export interface BotSettings {
    // Trading Parameters
    INITIAL_VIRTUAL_BALANCE: number;
    MAX_OPEN_POSITIONS: number;
    POSITION_SIZE_PCT: number;
    RISK_REWARD_RATIO: number;
    STOP_LOSS_PCT: number;
    SLIPPAGE_PCT: number;
    USE_TRAILING_STOP_LOSS: boolean;
    TRAILING_STOP_LOSS_PCT: number;
    
    // Market Scanner & Strategy Filters
    MIN_VOLUME_USD: number;
    SCANNER_DISCOVERY_INTERVAL_SECONDS: number;
    EXCLUDED_PAIRS: string;
    USE_VOLUME_CONFIRMATION: boolean;
    USE_MARKET_REGIME_FILTER: boolean;
    REQUIRE_STRONG_BUY: boolean;
    LOSS_COOLDOWN_HOURS: number;
    
    // API Credentials
    BINANCE_API_KEY: string;
    BINANCE_SECRET_KEY: string;

    // --- ADVANCED STRATEGY & RISK MANAGEMENT ---
    // ATR Stop Loss
    USE_ATR_STOP_LOSS: boolean;
    ATR_MULTIPLIER: number;
    
    // Auto Break-even
    USE_AUTO_BREAKEVEN: boolean;
    BREAKEVEN_TRIGGER_R: number; // R-multiple to trigger break-even
    ADJUST_BREAKEVEN_FOR_FEES: boolean;
    TRANSACTION_FEE_PCT: number;

    // RSI Overbought Filter
    RSI_OVERBOUGHT_THRESHOLD: number;
    
    // Partial Take Profit
    USE_PARTIAL_TAKE_PROFIT: boolean;
    PARTIAL_TP_TRIGGER_PCT: number; // PnL % to trigger the partial sell
    PARTIAL_TP_SELL_QTY_PCT: number; // % of original position to sell

    // Dynamic Position Sizing
    USE_DYNAMIC_POSITION_SIZING: boolean;
    STRONG_BUY_POSITION_SIZE_PCT: number;

    // Parabolic Move Filter
    USE_PARABOLIC_FILTER: boolean;
    PARABOLIC_FILTER_PERIOD_MINUTES: number;
    PARABOLIC_FILTER_THRESHOLD_PCT: number;

    // The single source of truth for the RSI safety filter toggle
    USE_RSI_SAFETY_FILTER: boolean;

    // --- ADAPTIVE BEHAVIOR ---
    USE_DYNAMIC_PROFILE_SELECTOR: boolean;
    ADX_THRESHOLD_RANGE: number; // e.g., below 20 indicates a ranging market
    ATR_PCT_THRESHOLD_VOLATILE: number; // e.g., above 5% indicates a volatile market
    USE_AGGRESSIVE_ENTRY_LOGIC: boolean; // For specific profiles like Volatility Hunter
    
    // Adaptive Trailing Stop
    USE_ADAPTIVE_TRAILING_STOP: boolean;
    TRAILING_STOP_TIGHTEN_THRESHOLD_R: number; // e.g., 1.5 (for 1.5R)
    TRAILING_STOP_TIGHTEN_MULTIPLIER_REDUCTION: number; // e.g., 0.5 (to reduce ATR multiplier)

    // Graduated Circuit Breaker
    CIRCUIT_BREAKER_WARN_THRESHOLD_PCT: number; // e.g. 2.0 for -2%
    CIRCUIT_BREAKER_HALT_THRESHOLD_PCT: number; // e.g. 4.0 for -4%
    DAILY_DRAWDOWN_LIMIT_PCT: number; // e.g. 3.0 for -3%
    CONSECUTIVE_LOSS_LIMIT: number; // e.g. 5

    // --- ADVANCED ENTRY CONFIRMATION ---
    USE_MTF_VALIDATION: boolean;
    USE_OBV_VALIDATION: boolean;
    USE_CVD_FILTER: boolean; // New: Cumulative Volume Delta Filter

    // --- NEW ADVANCED CONFIRMATION FILTERS ---
    USE_RSI_MTF_FILTER: boolean; // New: Multi-timeframe RSI check
    RSI_15M_OVERBOUGHT_THRESHOLD: number; // New
    USE_WICK_DETECTION_FILTER: boolean; // New: Check for large upper wicks on trigger candle
    MAX_UPPER_WICK_PCT: number; // New
    USE_OBV_5M_VALIDATION: boolean; // New: Validate OBV on 5m chart after confirmation

    // --- PORTFOLIO INTELLIGENCE ---
    SCALING_IN_CONFIG: string; // New: Flexible scaling in, e.g., "50,50" or "40,30,30"
    MAX_CORRELATED_TRADES: number;
    USE_FEAR_AND_GREED_FILTER: boolean;

    // --- ADVANCED PORTFOLIO FILTERS ---
    USE_ORDER_BOOK_LIQUIDITY_FILTER: boolean;
    MIN_ORDER_BOOK_LIQUIDITY_USD: number;
    USE_SECTOR_CORRELATION_FILTER: boolean;
    USE_WHALE_MANIPULATION_FILTER: boolean;
    WHALE_SPIKE_THRESHOLD_PCT: number; // e.g., 5 for 5% of hourly volume

    // --- EXPERIMENTAL STRATEGIES ---
    USE_IGNITION_STRATEGY: boolean;
    IGNITION_PRICE_THRESHOLD_PCT: number;
    IGNITION_VOLUME_MULTIPLIER: number;
    USE_FLASH_TRAILING_STOP: boolean;
    FLASH_TRAILING_STOP_PCT: number;
}