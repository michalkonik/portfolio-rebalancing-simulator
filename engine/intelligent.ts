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

/**
 * Weights for one check. "stay" means keep the coins already held.
 * The leader is the listed coin with the strongest trailing return against bitcoin,
 * and only if that coin is also above its own average. Bitcoin is the baseline:
 * it leads when no coin is beating it.
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
  const listed: number[] = [];
  for (let i = 0; i < assets.length; i++) {
    if (assets[i].symbol === "USDT") continue;
    if (price[i] > 0 && Number.isFinite(price[i])) listed.push(i);
  }
  if (listed.length === 0) return "stay";

  const btcNow = closeAt(btc, t);
  const btcThen = closeAt(btc, t - momentumDays * DAY);
  let best = -1;
  let bestScore = -Infinity;
  let btcIndex = -1;
  let btcEligible = false;
  for (const i of listed) {
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
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }

  const original = (): WeightTarget[] => assets.map((asset) => ({
    symbol: asset.symbol,
    weight: asset.weight,
    sellLocked: asset.sellLocked === true,
  }));
  const useBtc = btcEligible && btcIndex >= 0 && !(best >= 0 && bestScore > 0);
  const leader = useBtc ? btcIndex : best >= 0 && bestScore > 0 ? best : -1;
  if (leader < 0) {
    if (spec.defense === "stay") return "stay";
    if (spec.defense === "btc" && btcIndex >= 0) {
      return assets.map((asset, i) => ({
        symbol: asset.symbol,
        weight: i === btcIndex ? 1 : 0,
        sellLocked: false,
      }));
    }
    return original();
  }

  const share = listed.length === 1 ? 1 : leaderWeight;
  const rest = listed.length === 1 ? 0 : (1 - share) / (listed.length - 1);
  return assets.map((asset, i) => ({
    symbol: asset.symbol,
    weight: i === leader ? share : listed.includes(i) ? rest : 0,
    sellLocked: false,
  }));
}
