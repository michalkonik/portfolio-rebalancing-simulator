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

export type Frequency = "none" | "daily" | "weekly" | "biweekly" | "monthly" | "custom";

export type IntelligentDefense = "stay" | "equal" | "btc";

/** Causal tilt. Uses only prices up to the current bar. */
export interface IntelligentSpec {
  enabled: boolean;
  /** Trailing window for relative strength, in days. */
  momentumDays: number;
  /** A coin can lead only while its price is above this daily average. */
  trendDays: number;
  /** Share of the book given to the leader. The rest is split across the other coins that already trade. */
  leaderWeight: number;
  /** vsbtc: strength against bitcoin. absolute: strength in USDT. */
  score: "vsbtc" | "absolute";
  /**
   * What to do when no selected coin qualifies.
   * stay keeps the current mix. equal returns to the typed weights.
   * btc is accepted from older books and means equal. Bitcoin is never added.
   */
  defense: IntelligentDefense;
  /**
   * Optional overlay. Omitted means the leader rule.
   * down-*: majority of selected coins are at or below their average.
   * alldown-*: every selected coin is.
   * btc-*: bitcoin's own average, used only as a switch. Bitcoin is not added to the book.
   * mix returns to the typed weights. stay skips the check.
   * above-only holds a coin only while it is above its average.
   */
  regime?: "down-mix" | "down-stay" | "alldown-mix" | "alldown-stay" | "btc-mix" | "btc-stay" | "above-only" | "cowen";
  /** Average length for the regime switch. Omitted uses trendDays. */
  regimeDays?: number;
  /** Cowen gate: bitcoin must close above this average. 0 or omitted leaves it out. */
  btcMaDays?: number;
  /** Second, shorter bitcoin average. Both must pass. 0 or omitted leaves it out. */
  btcFastMaDays?: number;
  /** Tilt only while BTC dominance is below this average. 0 or omitted leaves it out. */
  dominanceMaDays?: number;
  /** Tilt only while total market cap is above this average. 0 or omitted leaves it out. */
  totalMaDays?: number;
  /** What to do when a Cowen filter fails. stay skips the check. mix returns to the entered weights. cash sells the book into USDT. */
  riskOff?: "stay" | "mix" | "cash";
  /** With cash: park only when no selected coin is above its own average. A coin still in an uptrend keeps the leader rule. */
  cashWhenWeak?: boolean;
  /** What to do when every Cowen filter passes. leader is the momentum tilt. mix returns to the entered weights. */
  riskOn?: "leader" | "mix";
}

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
  /** Used when frequency is "custom". Rebalance this many UTC days after the previous check. */
  everyDays?: number;
  /** Optional tilt that replaces a fixed-weight rebalance while it is enabled. */
  intelligent?: IntelligentSpec;
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
