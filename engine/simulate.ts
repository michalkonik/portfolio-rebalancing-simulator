import { intelligentTargets } from "./intelligent.ts";
import { pathStats } from "./metrics.ts";
import type {
  AssetSpec,
  BlockedBuyPolicy,
  CandleSeries,
  Frequency,
  Point,
  RebalanceEvent,
  SimInput,
  SimResult,
  SimSuccess,
  Trade,
  YearReturn,
} from "./types.ts";

const DAY = 86_400_000;
const HOUR4 = 4 * 60 * 60 * 1000;
const MAX_GAP = DAY;
const TRAIL = 30 * DAY;
const EPS = 1e-8;

interface NormAsset {
  symbol: string;
  weight: number;
  sellLocked: boolean;
}

interface Bar {
  t: number;
  price: number[];
  sma: (number | null)[];
}

interface Book {
  qty: number[];
  usdt: number;
}

export function normalizeAssets(assets: AssetSpec[]): NormAsset[] | string {
  if (assets.length < 1 || assets.length > 10) {
    return "Choose between 1 and 10 assets.";
  }
  const seen = new Set<string>();
  let sum = 0;
  const cleaned: NormAsset[] = [];
  for (const asset of assets) {
    const symbol = asset.symbol.trim().toUpperCase();
    if (!symbol) return "Every asset needs a symbol.";
    if (seen.has(symbol)) return `Duplicate symbol ${symbol}.`;
    seen.add(symbol);
    if (!(asset.weight > 0) || !Number.isFinite(asset.weight)) {
      return `Weight for ${symbol} must be a positive number.`;
    }
    sum += asset.weight;
    cleaned.push({ symbol, weight: asset.weight, sellLocked: asset.sellLocked === true });
  }
  if (!(sum > 0)) return "Weights must sum to a positive number.";
  for (const asset of cleaned) asset.weight /= sum;
  return cleaned;
}

function findAtOrBefore(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return idx;
}

function dailyCloses(series: CandleSeries): { days: number[]; closes: number[] } {
  const days: number[] = [];
  const closes: number[] = [];
  for (let i = 0; i < series.t.length; i++) {
    const day = Math.floor(series.t[i] / DAY);
    const close = series.c[i];
    if (!(close > 0)) continue;
    if (days.length === 0 || days[days.length - 1] !== day) {
      days.push(day);
      closes.push(close);
    } else closes[closes.length - 1] = close;
  }
  return { days, closes };
}

function smaBefore(days: number[], closes: number[], day: number, n: number): number | null {
  if (n < 1) return null;
  let lo = 0;
  let hi = days.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (days[mid] < day) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (idx + 1 < n) return null;
  let sum = 0;
  for (let i = idx - n + 1; i <= idx; i++) sum += closes[i];
  return sum / n;
}

function precomputeSma(series: CandleSeries, n: number): number[] {
  const daily = dailyCloses(series);
  const out = new Array<number>(series.t.length).fill(Number.NaN);
  let lastDay = -1;
  let cached = Number.NaN;
  for (let i = 0; i < series.t.length; i++) {
    const day = Math.floor(series.t[i] / DAY);
    if (day !== lastDay) {
      const value = smaBefore(daily.days, daily.closes, day, n);
      cached = value == null ? Number.NaN : value;
      lastDay = day;
    }
    out[i] = cached;
  }
  return out;
}

function buildBars(
  assets: NormAsset[],
  series: Record<string, CandleSeries>,
  startMs: number,
  endMs: number,
  smaDays: number,
  useSma: boolean,
): Bar[] | string {
  const indexed: CandleSeries[] = [];
  const smas: number[][] = [];
  for (const asset of assets) {
    if (asset.symbol === "USDT") {
      indexed.push({ symbol: "USDT", t: [], o: [], c: [] });
      smas.push([]);
      continue;
    }
    const candles = series[asset.symbol];
    if (!candles || candles.t.length === 0) return `No candles for ${asset.symbol}.`;
    indexed.push(candles);
    smas.push(useSma ? precomputeSma(candles, smaDays) : []);
  }
  const times = new Set<number>();
  for (let a = 0; a < assets.length; a++) {
    if (assets[a].symbol === "USDT") continue;
    const candles = indexed[a];
    for (let i = 0; i < candles.t.length; i++) {
      const ts = candles.t[i];
      if (ts >= startMs && ts <= endMs) times.add(ts);
    }
  }
  const grid = [...times].sort((a, b) => a - b);
  if (grid.length < 2) {
    return "Not enough candles in that date range. Widen the range or pick coins with longer history.";
  }
  const cursors = indexed.map(() => 0);
  const lastPrice = new Array<number>(assets.length).fill(Number.NaN);
  const bars: Bar[] = [];
  for (const ts of grid) {
    const price = new Array<number>(assets.length);
    const sma = new Array<number | null>(assets.length).fill(null);
    let fresh = false;
    for (let a = 0; a < assets.length; a++) {
      if (assets[a].symbol === "USDT") {
        price[a] = 1;
        sma[a] = 1;
        continue;
      }
      const candles = indexed[a];
      let cursor = cursors[a];
      while (cursor + 1 < candles.t.length && candles.t[cursor + 1] <= ts) cursor += 1;
      cursors[a] = cursor;
      const known = candles.t[cursor] <= ts ? cursor : -1;
      if (known >= 0 && candles.c[known] > 0) {
        lastPrice[a] = candles.c[known];
        const raw = smas[a][known];
        sma[a] = raw == null || Number.isNaN(raw) ? null : raw;
        if (ts - candles.t[known] <= MAX_GAP) fresh = true;
      }
      // NaN until the first candle. After that, carry the last close so a gap does not zero the book.
      price[a] = lastPrice[a];
    }
    if (fresh) bars.push({ t: ts, price, sma });
  }
  if (bars.length < 2) {
    return "Not enough candles in that date range. Widen the range or pick coins with longer history.";
  }
  return bars;
}

function priced(value: number): boolean {
  return value > 0 && Number.isFinite(value);
}

function clock(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Calendar slot. Weekly and biweekly advance on the chosen UTC weekday. Monthly advances on the chosen day. */
function periodIndex(
  t: number,
  frequency: Frequency,
  weekday: number,
  monthDay: number,
  everyDays = 30,
  originMs = 0,
): number {
  if (frequency === "none") return 0;
  const dayIndex = Math.floor(t / DAY);
  if (frequency === "custom") {
    const span = Math.max(1, Math.round(everyDays));
    const origin = originMs > 0 ? Math.floor(originMs / DAY) : 0;
    return Math.floor((dayIndex - origin) / span);
  }
  if (frequency === "daily") return dayIndex;
  if (frequency === "weekly" || frequency === "biweekly") {
    // 1970-01-01 was a Thursday, so dayIndex 0 is weekday 4.
    const offset = (weekday - 4 + 7) % 7;
    const week = Math.floor((dayIndex - offset) / 7);
    return frequency === "weekly" ? week : Math.floor(week / 2);
  }
  const date = new Date(t);
  let year = date.getUTCFullYear();
  let month = date.getUTCMonth();
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const target = Math.min(monthDay, last);
  if (date.getUTCDate() < target) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return year * 12 + month;
}

function tradeCost(symbol: string, cost: number): number {
  return symbol === "USDT" ? 0 : cost;
}

function trailReturn(series: CandleSeries | undefined, t: number, price: number): number | null {
  if (!series || !(price > 0)) return null;
  const idx = findAtOrBefore(series.t, t - TRAIL);
  if (idx < 0) return null;
  const prev = series.c[idx];
  if (!(prev > 0)) return null;
  return price / prev - 1;
}

interface Planned {
  symbol: string;
  index: number;
  /** Coin value to sell or to receive. */
  value: number;
}

function planRebalance(
  assets: NormAsset[],
  book: Book,
  bar: Bar,
  cost: number,
  band: number,
  fraction: number,
  trendOn: boolean,
  policy: BlockedBuyPolicy,
): { sells: Planned[]; buys: Planned[] } | null {
  const n = assets.length;
  let equity = book.usdt;
  const current = new Array<number>(n);
  const tradable = new Array<boolean>(n);
  for (let i = 0; i < n; i++) {
    tradable[i] = priced(bar.price[i]);
    current[i] = tradable[i] ? book.qty[i] * bar.price[i] : 0;
    equity += current[i];
  }
  if (!(equity > EPS)) return null;

  let maxGap = 0;
  for (let i = 0; i < n; i++) {
    if (!tradable[i]) continue;
    maxGap = Math.max(maxGap, Math.abs(current[i] / equity - assets[i].weight));
  }
  if (band > 0 && maxGap + 1e-12 < band) return null;

  const desired = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    if (!tradable[i]) {
      desired[i] = current[i];
      continue;
    }
    const target = equity * assets[i].weight;
    desired[i] = current[i] + fraction * (target - current[i]);
    if (assets[i].sellLocked && desired[i] < current[i]) desired[i] = current[i];
    if (trendOn && assets[i].symbol !== "USDT") {
      const sma = bar.sma[i];
      const below = sma != null && bar.price[i] < sma;
      if (below && desired[i] > current[i]) desired[i] = current[i];
    }
  }

  const sells: Planned[] = [];
  const buys: Planned[] = [];
  for (let i = 0; i < n; i++) {
    const delta = desired[i] - current[i];
    if (delta < -1e-6) sells.push({ symbol: assets[i].symbol, index: i, value: -delta });
    else if (delta > 1e-6) buys.push({ symbol: assets[i].symbol, index: i, value: delta });
  }
  if (sells.length === 0 && buys.length === 0) return null;

  const strategicUsdt = assets.some((asset) => asset.symbol === "USDT");
  const freeCash = strategicUsdt ? 0 : book.usdt;

  const raisedBy = (scale: number) => {
    let cash = freeCash;
    for (const sell of sells) cash += sell.value * scale * (1 - tradeCost(sell.symbol, cost));
    return cash;
  };
  const spendFor = (scale: number) => {
    let spend = 0;
    for (const buy of buys) {
      const rate = tradeCost(buy.symbol, cost);
      const value = buy.value * scale;
      spend += rate === 0 ? value : value / (1 - rate);
    }
    return spend;
  };

  let sellScale = 1;
  let buyScale = 1;
  if (policy === "keep_winners") {
    const spendFull = spendFor(1);
    if (spendFull <= EPS) {
      sellScale = 0;
      buyScale = 0;
    } else if (freeCash >= spendFull - 1e-8) {
      sellScale = 0;
      buyScale = 1;
    } else {
      const raisedFull = raisedBy(1) - freeCash;
      const need = spendFull - freeCash;
      sellScale = raisedFull > EPS ? Math.min(1, need / raisedFull) : 0;
      const affordable = raisedBy(sellScale);
      buyScale = spendFull > EPS ? Math.min(1, affordable / spendFull) : 0;
    }
  } else {
    const spendFull = spendFor(1);
    const affordable = raisedBy(1);
    buyScale = spendFull > EPS ? Math.min(1, affordable / spendFull) : 0;
    sellScale = 1;
  }

  if (sellScale <= EPS && buyScale <= EPS) return null;
  for (const sell of sells) sell.value *= sellScale;
  for (const buy of buys) buy.value *= buyScale;
  return {
    sells: sells.filter((row) => row.value > 1e-6),
    buys: buys.filter((row) => row.value > 1e-6),
  };
}

function applyPlan(
  book: Book,
  bar: Bar,
  plan: { sells: Planned[]; buys: Planned[] },
  cost: number,
  series: Record<string, CandleSeries>,
): { trades: Trade[]; fee: number } {
  const trades: Trade[] = [];
  let fee = 0;
  let cash = book.usdt;
  for (const sell of plan.sells) {
    const price = bar.price[sell.index];
    if (!(price > 0)) continue;
    let qty = Math.min(book.qty[sell.index], sell.value / price);
    if (!(qty > EPS)) continue;
    const notional = qty * price;
    const rate = tradeCost(sell.symbol, cost);
    const received = notional * (1 - rate);
    const paid = notional * rate;
    book.qty[sell.index] -= qty;
    cash += received;
    fee += paid;
    trades.push({
      t: bar.t,
      side: "sell",
      symbol: sell.symbol,
      qty,
      price,
      notional,
      cash: received,
      fee: paid,
      trail: trailReturn(series[sell.symbol], bar.t, price),
    });
  }
  for (const buy of plan.buys) {
    const price = bar.price[buy.index];
    if (!(price > 0)) continue;
    const rate = tradeCost(buy.symbol, cost);
    const spendNeed = rate === 0 ? buy.value : buy.value / (1 - rate);
    const spend = Math.min(cash, spendNeed);
    if (!(spend > EPS)) continue;
    const receivedValue = spend * (1 - rate);
    const qty = receivedValue / price;
    book.qty[buy.index] += qty;
    cash -= spend;
    const paid = spend * rate;
    fee += paid;
    trades.push({
      t: bar.t,
      side: "buy",
      symbol: buy.symbol,
      qty,
      price,
      notional: receivedValue,
      cash: spend,
      fee: paid,
      trail: trailReturn(series[buy.symbol], bar.t, price),
    });
  }
  book.usdt = cash;
  return { trades, fee };
}

function mark(assets: NormAsset[], book: Book, price: number[]): { equity: number; weights: number[]; values: number[] } {
  let equity = book.usdt;
  const values = new Array<number>(assets.length);
  for (let i = 0; i < assets.length; i++) {
    values[i] = priced(price[i]) ? book.qty[i] * price[i] : 0;
    equity += values[i];
  }
  const weights = values.map((value) => (equity > 0 ? value / equity : 0));
  return { equity, weights, values };
}

function enter(
  assets: NormAsset[],
  price: number[],
  cash: number,
  cost: number,
): { book: Book; fee: number; reserved: number[] } {
  const book: Book = { qty: new Array<number>(assets.length).fill(0), usdt: 0 };
  const reserved = new Array<number>(assets.length).fill(0);
  let fee = 0;
  let left = cash;
  for (let i = 0; i < assets.length; i++) {
    const spend = cash * assets[i].weight;
    if (!priced(price[i])) {
      reserved[i] = spend;
      continue;
    }
    const rate = tradeCost(assets[i].symbol, cost);
    const received = spend * (1 - rate);
    book.qty[i] = received / price[i];
    left -= spend;
    fee += spend * rate;
  }
  book.usdt = left;
  return { book, fee, reserved };
}

/** Spend earmarked cash on a coin that just listed. This is the initial fill, not a rebalance. */
function buyReserved(
  book: Book,
  index: number,
  symbol: string,
  budget: number,
  price: number,
  cost: number,
): { spent: number; fee: number } {
  if (!(budget > EPS) || !priced(price)) return { spent: 0, fee: 0 };
  const rate = tradeCost(symbol, cost);
  const spend = Math.min(book.usdt, budget);
  if (!(spend > EPS)) return { spent: 0, fee: 0 };
  book.qty[index] += (spend * (1 - rate)) / price;
  book.usdt -= spend;
  return { spent: spend, fee: spend * rate };
}

function btcPriceAt(btc: CandleSeries | null | undefined, t: number, cache: { idx: number }): number | null {
  if (!btc || btc.t.length === 0) return null;
  let idx = cache.idx;
  while (idx + 1 < btc.t.length && btc.t[idx + 1] <= t) idx += 1;
  cache.idx = idx;
  if (btc.t[idx] > t) return null;
  if (t - btc.t[idx] > MAX_GAP) return null;
  return btc.c[idx] > 0 ? btc.c[idx] : null;
}

function dragUsdt(events: RebalanceEvent[], assets: NormAsset[], last: number[]): number {
  const endPrice = new Map<string, number>();
  assets.forEach((asset, i) => endPrice.set(asset.symbol, last[i]));
  endPrice.set("USDT", 1);
  let drag = 0;
  for (const event of events) {
    const sells = event.trades.filter((trade) => trade.side === "sell");
    const buys = event.trades.filter((trade) => trade.side === "buy");
    const cashIn = sells.reduce((sum, trade) => sum + trade.cash, 0);
    const cashOut = buys.reduce((sum, trade) => sum + trade.cash, 0);
    if (!(cashIn > EPS)) continue;
    const parked = Math.max(0, cashIn - cashOut);
    for (const sell of sells) {
      const soldEndRaw = endPrice.get(sell.symbol);
      const soldEnd = soldEndRaw != null && priced(soldEndRaw) ? soldEndRaw : sell.price;
      const retSold = soldEnd / sell.price - 1;
      for (const buy of buys) {
        const share = (sell.cash / cashIn) * buy.cash;
        const boughtEndRaw = endPrice.get(buy.symbol);
        const boughtEnd = boughtEndRaw != null && priced(boughtEndRaw) ? boughtEndRaw : buy.price;
        const retBought = boughtEnd / buy.price - 1;
        drag += share * (retSold - retBought);
      }
      if (parked > 0) drag += (sell.cash / cashIn) * parked * retSold;
    }
  }
  return drag;
}

function soldStrength(trades: Trade[]): boolean {
  const sells = trades.filter((trade) => trade.side === "sell" && trade.trail != null);
  const buys = trades.filter((trade) => trade.side === "buy" && trade.symbol !== "USDT" && trade.trail != null);
  if (sells.length === 0 || buys.length === 0) return false;
  const bestSold = Math.max(...sells.map((trade) => trade.trail ?? -Infinity));
  const worstBought = Math.min(...buys.map((trade) => trade.trail ?? Infinity));
  return bestSold > worstBought + 1e-9;
}

function yearReturns(points: Point[]): YearReturn[] {
  if (points.length === 0) return [];
  const rows: YearReturn[] = [];
  let year = new Date(points[0].t).getUTCFullYear();
  let baseS = points[0].equity;
  let baseH = points[0].hold;
  let baseB = points[0].btc;
  let last = points[0];
  const push = (through: Point) => {
    rows.push({
      year,
      strategy: baseS > 0 ? through.equity / baseS - 1 : 0,
      hold: baseH > 0 ? through.hold / baseH - 1 : 0,
      btc: baseB != null && baseB > 0 && through.btc != null ? through.btc / baseB - 1 : null,
    });
  };
  for (const point of points) {
    const y = new Date(point.t).getUTCFullYear();
    if (y !== year) {
      push(last);
      year = y;
      baseS = last.equity;
      baseH = last.hold;
      baseB = last.btc;
    }
    last = point;
  }
  push(last);
  return rows;
}

export function simulate(input: SimInput): SimResult {
  const normalized = normalizeAssets(input.assets);
  if (typeof normalized === "string") return { ok: false, error: normalized };
  if (!(input.initialUsdt > 0) || !Number.isFinite(input.initialUsdt)) {
    return { ok: false, error: "Starting capital must be a positive number of USDT." };
  }
  if (!(input.endMs > input.startMs)) return { ok: false, error: "The end date must be after the start date." };
  const cost = (input.feeBps + input.slippageBps) / 10_000;
  if (!Number.isFinite(cost) || cost < 0 || cost >= 0.25) {
    return { ok: false, error: "Fee plus slippage must be between 0 and 25%." };
  }
  if (!Number.isFinite(input.band) || input.band < 0 || input.band >= 1) {
    return { ok: false, error: "The drift band must be between 0 and 100 percentage points." };
  }
  if (!Number.isFinite(input.fraction) || input.fraction <= 0 || input.fraction > 1) {
    return { ok: false, error: "Rebalance fraction must be above 0 and at most 100%." };
  }
  const smaDays = Math.round(input.trend.smaDays);
  if (input.trend.enabled && (smaDays < 2 || smaDays > 400)) {
    return { ok: false, error: "Moving-average length must be between 2 and 400 days." };
  }

  const built = buildBars(
    normalized,
    input.series,
    input.startMs,
    input.endMs,
    smaDays,
    input.trend.enabled,
  );
  if (typeof built === "string") return { ok: false, error: built };
  const bars = built;
  const weekday = clock(input.weekday, 0, 6, 1);
  const monthDay = clock(input.monthDay, 1, 31, 1);
  const everyDays = clock(input.everyDays, 1, 365, 30);
  const intelligent = input.intelligent?.enabled === true ? input.intelligent : null;
  const warnings: string[] = [];
  if (bars[0].t > input.startMs + HOUR4) {
    warnings.push(
      `History for this mix starts ${new Date(bars[0].t).toISOString().slice(0, 10)}, later than the requested start.`,
    );
  }
  if (bars[bars.length - 1].t + HOUR4 < input.endMs) {
    warnings.push(
      `History for this mix ends ${new Date(bars[bars.length - 1].t).toISOString().slice(0, 10)}.`,
    );
  }
  for (const asset of normalized) {
    if (asset.symbol === "USDT") continue;
    const first = input.series[asset.symbol]?.t[0];
    if (first != null && first > bars[0].t + HOUR4) {
      warnings.push(
        `${asset.symbol} has no price until ${new Date(first).toISOString().slice(0, 10)}. A plain rebalance holds that share as USDT until the next check after it lists. Intelligent rebalancing spreads that share across the selected coins that already trade, and only then gives ${asset.symbol} a weight. The chart still starts with the coins that already trade.`,
      );
    }
  }

  const holdOpened = enter(normalized, bars[0].price, input.initialUsdt, cost);
  const hold = holdOpened.book;
  const holdReserved = holdOpened.reserved.slice();
  const openingTargets = intelligent
    ? intelligentTargets(normalized, input.series, input.btc, bars[0].t, bars[0].price, intelligent)
    : null;
  const strategyOpened = enter(
    openingTargets && openingTargets !== "stay" ? openingTargets : normalized,
    bars[0].price,
    input.initialUsdt,
    cost,
  );
  const strategy = strategyOpened.book;
  let fees = strategyOpened.fee;

  const btcCache = { idx: 0 };
  const firstBtc = btcPriceAt(input.btc, bars[0].t, btcCache);
  const btcQty = firstBtc != null ? (input.initialUsdt * (1 - cost)) / firstBtc : null;

  const points: Point[] = [];
  const events: RebalanceEvent[] = [];
  const anchor = bars[0].t;
  let prevPeriod = periodIndex(anchor, input.frequency, weekday, monthDay, everyDays, anchor);
  let listed = bars[0].price.map((price) => priced(price));

  const equities: number[] = [];
  const times: number[] = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const nowListed = bar.price.map((price) => priced(price));
    const newly = nowListed.some((ok, index) => ok && !listed[index]);
    if (newly) {
      for (let a = 0; a < normalized.length; a++) {
        if (!nowListed[a] || !(holdReserved[a] > EPS)) continue;
        const bought = buyReserved(hold, a, normalized[a].symbol, holdReserved[a], bar.price[a], cost);
        holdReserved[a] = Math.max(0, holdReserved[a] - bought.spent);
        if (input.frequency === "none" && !intelligent) {
          const strategyBuy = buyReserved(strategy, a, normalized[a].symbol, bought.spent, bar.price[a], cost);
          fees += strategyBuy.fee;
        }
      }
    }
    if (i > 0 && input.frequency !== "none") {
      const period = periodIndex(bar.t, input.frequency, weekday, monthDay, everyDays, anchor);
      if (period > prevPeriod || newly) {
        const targets = intelligent
          ? intelligentTargets(normalized, input.series, input.btc, bar.t, bar.price, intelligent)
          : normalized;
        const planned = targets === "stay" ? null : planRebalance(
          targets,
          strategy,
          bar,
          cost,
          intelligent ? 0 : input.band,
          intelligent ? 1 : input.fraction,
          intelligent ? false : input.trend.enabled,
          intelligent ? "park_usdt" : input.blockedBuyPolicy,
        );
        if (planned && (planned.sells.length > 0 || planned.buys.length > 0)) {
          const applied = applyPlan(strategy, bar, planned, cost, input.series);
          fees += applied.fee;
          if (applied.trades.length > 0) {
            events.push({
              t: bar.t,
              trades: applied.trades,
              soldStrengthToWeakness: soldStrength(applied.trades),
            });
          }
        }
      }
      prevPeriod = period;
    }
    listed = nowListed;

    const marked = mark(normalized, strategy, bar.price);
    const held = mark(normalized, hold, bar.price);
    const btcPx = btcPriceAt(input.btc, bar.t, btcCache);
    const btcEq = btcQty != null && btcPx != null ? btcQty * btcPx : null;
    points.push({
      t: bar.t,
      equity: marked.equity,
      hold: held.equity,
      btc: btcEq,
      btcPrice: btcPx,
      qty: strategy.qty.slice(),
      values: marked.values.slice(),
      usdt: strategy.usdt,
      weights: marked.weights,
    });
    equities.push(marked.equity);
    times.push(bar.t);
  }

  const stats = pathStats(equities, times, input.initialUsdt);
  const holdEq = points.map((point) => point.hold);
  const holdStats = pathStats(holdEq, times, input.initialUsdt);
  const btcEq = points.map((point) => point.btc ?? Number.NaN);
  const hasBtc = points.every((point) => point.btc != null);
  const btcStats = hasBtc ? pathStats(btcEq, times, input.initialUsdt) : null;
  const last = points[points.length - 1];
  const drag = dragUsdt(events, normalized, bars[bars.length - 1].price);
  const turnover = events.reduce(
    (sum, event) => sum + event.trades.reduce((inner, trade) => inner + trade.notional, 0),
    0,
  );

  const endingQty: Record<string, number> = {};
  normalized.forEach((asset, i) => {
    endingQty[asset.symbol] = last.qty[i];
  });

  const summary = {
    finalEquity: last.equity,
    holdFinal: last.hold,
    btcFinal: hasBtc ? last.btc : null,
    totalReturn: stats.totalReturn,
    holdReturn: holdStats.totalReturn,
    btcReturn: btcStats ? btcStats.totalReturn : null,
    cagr: stats.cagr,
    holdCagr: holdStats.cagr,
    btcCagr: btcStats ? btcStats.cagr : null,
    maxDrawdown: stats.maxDrawdown,
    holdMaxDrawdown: holdStats.maxDrawdown,
    btcMaxDrawdown: btcStats ? btcStats.maxDrawdown : null,
    volatility: stats.volatility,
    sharpe: stats.sharpe,
    sortino: stats.sortino,
    calmar: stats.calmar,
    fees,
    turnover,
    rebalances: events.length,
    trapEvents: events.filter((event) => event.soldStrengthToWeakness).length,
    dragUsdt: drag,
    endingQty,
    endingUsdt: last.usdt,
  };

  const result: SimSuccess = {
    ok: true,
    assets: normalized,
    anchorMs: anchor,
    startMs: bars[0].t,
    endMs: bars[bars.length - 1].t,
    warnings,
    points,
    events,
    summary,
    years: yearReturns(points),
  };
  return result;
}

/** Same book with the guards removed, so the trap is visible next to the protected run. */
export function simulateNaive(input: SimInput): SimResult {
  return simulate({
    ...input,
    band: 0,
    fraction: 1,
    trend: { enabled: false, smaDays: input.trend.smaDays },
    blockedBuyPolicy: "keep_winners",
    intelligent: input.intelligent ? { ...input.intelligent, enabled: false } : undefined,
    assets: input.assets.map((asset) => ({ ...asset, sellLocked: false })),
  });
}

export function guardsAreActive(input: SimInput): boolean {
  return (
    input.intelligent?.enabled === true ||
    input.band > 0 ||
    input.fraction < 1 - 1e-9 ||
    input.trend.enabled ||
    input.blockedBuyPolicy === "park_usdt" ||
    input.assets.some((asset) => asset.sellLocked === true)
  );
}
