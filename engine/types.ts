/** Shared types for the portfolio simulator. Pure data, no IO. */

export interface CandleSeries {
  symbol: string;
  /** Candle open time in Unix milliseconds, strictly increasing. */
  t: number[];
  o: number[];
  c: number[];
}

export interface AssetSpec {
  symbol: string;
  /** Positive allocation. Values are normalized to sum to 1 before the run. */
  weight: number;
  /** When true, a rebalance can buy this coin but can never sell it. */
  sellLocked?: boolean;
}

export type Frequency = "none" | "daily" | "weekly" | "biweekly" | "monthly";

export type BlockedBuyPolicy = "keep_winners" | "park_usdt";

export interface TrendFilter {
  enabled: boolean;
  /** Trailing daily simple moving average. Buys are blocked below it. */
  smaDays: number;
}

export interface SimInput {
  assets: AssetSpec[];
  /** Inclusive range. The run starts on the first bar at or after startMs. */
  startMs: number;
  endMs: number;
  initialUsdt: number;
  feeBps: number;
  slippageBps: number;
  frequency: Frequency;
  /**
   * UTC weekday for weekly and biweekly clocks. 0 is Sunday, 1 is Monday.
   * Omitted means Monday.
   */
  weekday?: number;
  /**
   * UTC day of month for the monthly clock, 1–31.
   * A shorter month uses its last day. Omitted means the 1st.
   */
  monthDay?: number;
  /**
   * Minimum absolute weight gap that must exist before a scheduled rebalance trades.
   * 0.05 means 5 percentage points (a 33% target trades outside 28–38%).
   */
  band: number;
  /** Share of the gap to close. 1 snaps to target, 0.5 sells half the excess. */
  fraction: number;
  trend: TrendFilter;
  blockedBuyPolicy: BlockedBuyPolicy;
  series: Record<string, CandleSeries>;
  /** Used only for the buy-and-hold BTC benchmark. Optional. */
  btc?: CandleSeries | null;
}

export interface Trade {
  t: number;
  side: "buy" | "sell";
  symbol: string;
  qty: number;
  price: number;
  /** Coin value at the fill price, before the fee haircut. */
  notional: number;
  /** Quote cash spent (buy) or received (sell). */
  cash: number;
  fee: number;
  /** Trailing return used for the ex-ante winner/laggard flag. Null if unknown. */
  trail: number | null;
}

export interface RebalanceEvent {
  t: number;
  trades: Trade[];
  /** True when a stronger trailing coin was sold to fund a weaker one. */
  soldStrengthToWeakness: boolean;
}

export interface Point {
  t: number;
  equity: number;
  hold: number;
  /** Buy-and-hold BTC equity, in USDT. Null when BTC has no price yet. */
  btc: number | null;
  /** Spot BTC close at this bar. Null when BTC has no price yet. */
  btcPrice: number | null;
  /** Quantities in asset order. */
  qty: number[];
  /** Mark-to-market USDT value of each asset, same order as qty. */
  values: number[];
  usdt: number;
  /** Portfolio weights in asset order. Residual USDT is 1 - sum. */
  weights: number[];
}

export interface YearReturn {
  year: number;
  strategy: number;
  hold: number;
  btc: number | null;
}

export interface Summary {
  finalEquity: number;
  holdFinal: number;
  btcFinal: number | null;
  totalReturn: number;
  holdReturn: number;
  btcReturn: number | null;
  cagr: number;
  holdCagr: number;
  btcCagr: number | null;
  maxDrawdown: number;
  holdMaxDrawdown: number;
  btcMaxDrawdown: number | null;
  volatility: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  fees: number;
  turnover: number;
  rebalances: number;
  trapEvents: number;
  /** Ex-post USDT gap from selling a coin that later beat whatever was bought. */
  dragUsdt: number;
  endingQty: Record<string, number>;
  endingUsdt: number;
}

export interface SimSuccess {
  ok: true;
  assets: Array<{ symbol: string; weight: number; sellLocked: boolean }>;
  anchorMs: number;
  startMs: number;
  endMs: number;
  warnings: string[];
  points: Point[];
  events: RebalanceEvent[];
  summary: Summary;
  years: YearReturn[];
}

export interface SimFailure {
  ok: false;
  error: string;
}

export type SimResult = SimSuccess | SimFailure;

export interface NaiveComparison {
  naive: SimSuccess;
  /** Strategy final minus naive final. Positive means the guards helped. */
  deltaUsdt: number;
}
