import type { AssetSpec, CandleSeries, IntelligentSpec } from "./types.ts";

const DAY = 86_400_000;

export interface WeightTarget {
  symbol: string;
  weight: number;
  sellLocked: boolean;
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

function closeAt(series: CandleSeries | null | undefined, t: number): number | null {
  if (!series || series.t.length === 0) return null;
  const idx = findAtOrBefore(series.t, t);
  if (idx < 0) return null;
  const close = series.c[idx];
  return close > 0 ? close : null;
}

/** Mean of daily closes strictly before this UTC day. Null until the window is full. */
function smaBefore(series: CandleSeries, dayIndex: number, days: number): number | null {
  if (days < 2) return null;
  let idx = findAtOrBefore(series.t, dayIndex * DAY - 1);
  const closes: number[] = [];
  let lastDay = -1;
  for (let i = idx; i >= 0 && closes.length < days; i--) {
    const day = Math.floor(series.t[i] / DAY);
    if (day >= dayIndex || day === lastDay) continue;
    const close = series.c[i];
    if (!(close > 0)) continue;
    closes.push(close);
    lastDay = day;
  }
  if (closes.length < days) return null;
  let sum = 0;
  for (const close of closes) sum += close;
  return sum / closes.length;
}

function allocate(assets: AssetSpec[], raw: number[]): WeightTarget[] {
  let sum = 0;
  for (const weight of raw) sum += weight;
  const scale = sum > 0 ? 1 / sum : 0;
  return assets.map((asset, i) => ({
    symbol: asset.symbol,
    weight: scale > 0 ? raw[i] * scale : 0,
    sellLocked: false,
  }));
}

/**
 * Weights for one check. "stay" means keep the coins already held.
 * Every weight belongs to a coin the user selected. They sum to 1.
 * Bitcoin is used only when it is already in the book.
 * If USDT is in the book, coins that fail the trend test move that weight into USDT.
 * If USDT is not in the book, the mix stays inside the selected coins.
 * The leader is the selected coin with the strongest trailing return,
 * and only while that coin is also above its own average.
 */
export function intelligentTargets(
  assets: AssetSpec[],
  series: Record<string, CandleSeries>,
  btc: CandleSeries | null | undefined,
  t: number,
  price: number[],
  spec: IntelligentSpec,
): WeightTarget[] | "stay" {
  const momentumDays = Math.max(2, Math.round(spec.momentumDays));
  const trendDays = Math.max(2, Math.round(spec.trendDays));
  const leaderWeight = Math.min(1, Math.max(0.05, spec.leaderWeight));
  const dayIndex = Math.floor(t / DAY);
  const tradable: number[] = [];
  for (let i = 0; i < assets.length; i++) {
    if (assets[i].symbol === "USDT") {
      tradable.push(i);
      continue;
    }
    if (price[i] > 0 && Number.isFinite(price[i])) tradable.push(i);
  }
  const coins = tradable.filter((i) => assets[i].symbol !== "USDT");
  if (coins.length === 0) return "stay";

  const btcNow = closeAt(btc, t);
  const btcThen = closeAt(btc, t - momentumDays * DAY);
  const qualifying: number[] = [];
  let best = -1;
  let bestScore = -Infinity;
  for (const i of coins) {
    const symbol = assets[i].symbol;
    const coin = series[symbol];
    const now = price[i];
    const then = closeAt(coin, t - momentumDays * DAY);
    const average = coin ? smaBefore(coin, dayIndex, trendDays) : null;
    if (average == null || now <= average || then == null) continue;
    let score = now / then - 1;
    if (
      spec.score === "vsbtc" &&
      symbol !== "BTC" &&
      btcNow != null &&
      btcThen != null &&
      btcNow > 0 &&
      btcThen > 0
    ) {
      score = (now / btcNow) / (then / btcThen) - 1;
    }
    if (!(score > 0)) continue;
    qualifying.push(i);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }

  const usdtIndex = assets.findIndex((asset) => asset.symbol === "USDT");
  const userMix = (): WeightTarget[] => {
    const raw = assets.map(() => 0);
    for (const i of tradable) raw[i] = assets[i].weight;
    return allocate(assets, raw);
  };

  if (usdtIndex >= 0) {
    if (qualifying.length === 0 || best < 0) {
      const raw = assets.map(() => 0);
      raw[usdtIndex] = 1;
      return allocate(assets, raw);
    }
    let typedSum = 0;
    for (const i of tradable) typedSum += assets[i].weight;
    const typed = (i: number) => (typedSum > 0 ? assets[i].weight / typedSum : 0);
    let usdtW = typed(usdtIndex);
    for (const i of coins) {
      if (!qualifying.includes(i)) usdtW += typed(i);
    }
    const risk = Math.max(0, 1 - usdtW);
    const raw = assets.map(() => 0);
    raw[usdtIndex] = usdtW;
    if (qualifying.length === 1) {
      raw[qualifying[0]] = risk;
    } else {
      const rest = (1 - leaderWeight) / (qualifying.length - 1);
      for (const i of qualifying) raw[i] = risk * (i === best ? leaderWeight : rest);
    }
    return allocate(assets, raw);
  }

  let altBest = -1;
  let altScore = -Infinity;
  let btcIndex = -1;
  let btcEligible = false;
  for (const i of coins) {
    const symbol = assets[i].symbol;
    const coin = series[symbol];
    const now = price[i];
    const then = closeAt(coin, t - momentumDays * DAY);
    const average = coin ? smaBefore(coin, dayIndex, trendDays) : null;
    const above = average != null && now > average;
    if (symbol === "BTC") btcIndex = i;
    if (!above || then == null) continue;
    let score = now / then - 1;
    if (
      spec.score === "vsbtc" &&
      symbol !== "BTC" &&
      btcNow != null &&
      btcThen != null &&
      btcNow > 0 &&
      btcThen > 0
    ) {
      score = (now / btcNow) / (then / btcThen) - 1;
    }
    if (symbol === "BTC") {
      btcEligible = true;
      continue;
    }
    if (score > altScore) {
      altScore = score;
      altBest = i;
    }
  }
  const useBtc = btcEligible && btcIndex >= 0 && !(altBest >= 0 && altScore > 0);
  const leader = useBtc ? btcIndex : altBest >= 0 && altScore > 0 ? altBest : -1;
  if (leader < 0) {
    if (spec.defense === "stay") return "stay";
    if (btcIndex >= 0) {
      const raw = assets.map(() => 0);
      raw[btcIndex] = 1;
      return allocate(assets, raw);
    }
    return userMix();
  }
  const share = coins.length === 1 ? 1 : leaderWeight;
  const rest = coins.length === 1 ? 0 : (1 - share) / (coins.length - 1);
  const raw = assets.map(() => 0);
  for (const i of coins) raw[i] = i === leader ? share : rest;
  return allocate(assets, raw);
}
