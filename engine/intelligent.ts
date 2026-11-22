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

function applyFloor(assets: AssetSpec[], raw: number[], floor: number): number[] {
  if (!(floor > 0)) return raw;
  const idxs: number[] = [];
  for (let i = 0; i < assets.length; i++) if (assets[i].symbol !== "USDT") idxs.push(i);
  if (idxs.length < 2) return raw;
  const each = Math.min(floor, 1 / idxs.length);
  const out = raw.slice();
  let need = 0;
  let spare = 0;
  for (const i of idxs) {
    if (out[i] < each) need += each - out[i];
    else spare += out[i] - each;
  }
  if (need <= 0 || spare <= 0) return out;
  const take = Math.min(1, need / spare);
  for (const i of idxs) out[i] = out[i] < each ? each : out[i] - (out[i] - each) * take;
  return out;
}

function allocate(assets: AssetSpec[], raw: number[], floor = 0): WeightTarget[] {
  const floored = applyFloor(assets, raw, floor);
  let sum = 0;
  for (const weight of floored) sum += weight;
  const scale = sum > 0 ? 1 / sum : 0;
  return assets.map((asset, i) => ({
    symbol: asset.symbol,
    weight: scale > 0 ? floored[i] * scale : 0,
    sellLocked: false,
  }));
}

const WEEK = 7 * DAY;

/** Completed weekly closes strictly before `before`. The current week is not included. */
function weeklyCloses(series: CandleSeries, before: number): number[] {
  const closes: number[] = [];
  let bucket = -1;
  let last = 0;
  for (let i = 0; i < series.t.length; i++) {
    if (series.t[i] >= before) break;
    const close = series.c[i];
    if (!(close > 0)) continue;
    const next = Math.floor(series.t[i] / WEEK);
    if (bucket >= 0 && next !== bucket) closes.push(last);
    bucket = next;
    last = close;
  }
  if (bucket >= 0 && (bucket + 1) * WEEK <= before) closes.push(last);
  return closes;
}

function smaLast(values: number[], n: number): number | null {
  if (n < 2 || values.length < n) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i++) sum += values[i];
  return sum / n;
}

function emaLast(values: number[], n: number): number | null {
  if (n < 2 || values.length < n) return null;
  let average = 0;
  for (let i = 0; i < n; i++) average += values[i];
  average /= n;
  const k = 2 / (n + 1);
  for (let i = n; i < values.length; i++) average = values[i] * k + average * (1 - k);
  return average;
}

/**
 * Cowen's public regime, reduced to prices we actually have.
 * Bitcoin is in a bull only while its weekly close is above the 20-week average
 * and the 21-week EMA. A tilt away from bitcoin also needs dominance to have
 * fallen for months and the other coin to be rising in dollars and against bitcoin.
 * Below the band, a book that holds bitcoin stays in bitcoin. It does not sell into USDT.
 * "leader" means the ordinary momentum tilt may run.
 */
function cowenBand(
  assets: AssetSpec[],
  series: Record<string, CandleSeries>,
  btc: CandleSeries | null | undefined,
  t: number,
  price: number[],
  spec: IntelligentSpec,
): WeightTarget[] | "stay" | "leader" {
  if (!btc) return "stay";
  const weeks = weeklyCloses(btc, t);
  const slowN = Math.max(2, Math.round(spec.bandWeeks ?? 20));
  const fastN = Math.max(2, Math.round(spec.bandEmaWeeks ?? 21));
  const slow = smaLast(weeks, slowN);
  const fast = emaLast(weeks, fastN);
  const weekly = weeks.length ? weeks[weeks.length - 1] : null;
  if (slow == null || fast == null || weekly == null) return "stay";
  const above = weekly > slow && weekly > fast;
  const floor = spec.floorWeight ?? 0;
  const btcIndex = assets.findIndex((asset) => asset.symbol === "BTC");
  const holdBtc = (): WeightTarget[] => {
    const raw = assets.map(() => 0);
    raw[btcIndex] = 1;
    return allocate(assets, raw, floor);
  };
  if (!above) return btcIndex >= 0 ? holdBtc() : "stay";

  const trendDays = Math.max(2, Math.round(spec.dominanceTrendDays ?? 90));
  const dominance = series.BTCD;
  const domNow = closeAt(dominance, t);
  const domThen = closeAt(dominance, t - trendDays * DAY);
  const dominanceFalling = domNow != null && domThen != null && domNow < domThen;
  let altsRising = false;
  let counted = 0;
  let rose = 0;
  for (let i = 0; i < assets.length; i++) {
    if (assets[i].symbol === "USDT" || assets[i].symbol === "BTC") continue;
    const then = closeAt(series[assets[i].symbol], t - trendDays * DAY);
    if (then == null || !(price[i] > 0)) continue;
    counted += 1;
    if (price[i] > then) rose += 1;
  }
  altsRising = counted > 0 && rose === counted;
  const pairDays = Math.max(2, Math.round(spec.pairMaDays ?? 140));
  let pairOk = btcIndex >= 0;
  const bNow = closeAt(btc, t);
  const day = Math.floor(t / DAY);
  if (btcIndex < 0 || bNow == null || !(bNow > 0)) pairOk = false;
  else {
    for (let i = 0; i < assets.length; i++) {
      if (assets[i].symbol === "USDT" || assets[i].symbol === "BTC") continue;
      let sum = 0;
      let n = 0;
      for (let back = 1; back <= pairDays; back++) {
        const b = closeAt(btc, (day - back) * DAY);
        const c = closeAt(series[assets[i].symbol], (day - back) * DAY);
        if (b == null || c == null || !(b > 0)) continue;
        sum += c / b;
        n += 1;
      }
      if (n < pairDays || !(price[i] > 0) || price[i] / bNow <= sum / n) pairOk = false;
    }
  }
  if (dominanceFalling && altsRising && pairOk) return "leader";
  if (btcIndex >= 0) return holdBtc();
  return "stay";
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
  if (spec.regime === "cowen-band") {
    const band = cowenBand(assets, series, btc, t, price, spec);
    if (band !== "leader") return band;
  }

  const userMix = (): WeightTarget[] => {
    const raw = assets.map(() => 0);
    for (const i of tradable) raw[i] = assets[i].weight;
    return allocate(assets, raw, spec.floorWeight ?? 0);
  };
  const regimeDays = Math.max(2, Math.round(spec.regimeDays ?? trendDays));
  const aboveAverage = (seriesFor: CandleSeries | null | undefined, px: number): boolean | null => {
    if (!seriesFor) return null;
    const average = smaBefore(seriesFor, dayIndex, regimeDays);
    if (average == null || !(px > 0)) return null;
    return px > average;
  };
  if (spec.regime === "cowen") {
    const slow = Math.round(spec.btcMaDays ?? 0);
    const fast = Math.round(spec.btcFastMaDays ?? 0);
    const domDays = Math.round(spec.dominanceMaDays ?? 0);
    const totalDays = Math.round(spec.totalMaDays ?? 0);
    const riskOnAt = (when: number): boolean => {
      const day = Math.floor(when / DAY);
      const aboveThen = (seriesFor: CandleSeries | null | undefined, px: number | null, days: number): boolean | null => {
        if (days < 2 || !seriesFor || px == null) return null;
        const average = smaBefore(seriesFor, day, days);
        if (average == null || !(px > 0)) return null;
        return px > average;
      };
      if (slow >= 2 || fast >= 2) {
        const px = closeAt(btc, when);
        if (slow >= 2 && aboveThen(btc, px, slow) !== true) return false;
        if (fast >= 2 && aboveThen(btc, px, fast) !== true) return false;
      }
      if (totalDays >= 2 && aboveThen(series.TOTAL, closeAt(series.TOTAL, when), totalDays) !== true) return false;
      if (domDays >= 2 && aboveThen(series.BTCD, closeAt(series.BTCD, when), domDays) !== false) return false;
      return true;
    };
    let riskOn = riskOnAt(t);
    const confirmDays = Math.round(spec.cashConfirmDays ?? 0);
    if (!riskOn && confirmDays >= 2 && spec.riskOff === "cash" && riskOnAt(t - confirmDays * DAY) !== false) {
      return "stay";
    }
    if (spec.cashOnBasketDown) {
      const lookback = Math.max(2, Math.round(spec.basketDays ?? momentumDays));
      const hurdle = spec.basketHurdle ?? 0;
      let summed = 0;
      let counted = 0;
      for (const i of coins) {
        const then = closeAt(series[assets[i].symbol], t - lookback * DAY);
        const now = price[i];
        if (then == null || !(then > 0) || !(now > 0)) continue;
        summed += now / then - 1;
        counted += 1;
      }
      const basket = counted > 0 ? summed / counted : 0;
      if (counted > 0 && basket < hurdle) {
        return assets.map((asset) => ({ symbol: asset.symbol, weight: 0, sellLocked: false }));
      }
      if (!riskOn) return userMix();
    } else if (!riskOn) {
      if (spec.riskOff === "mix") return userMix();
      if (spec.riskOff === "vsbtc") {
        let best = -1;
        let bestScore = -Infinity;
        for (const i of coins) {
          const now = price[i];
          const then = closeAt(series[assets[i].symbol], t - momentumDays * DAY);
          const btcNow = closeAt(btc, t);
          const btcThen = closeAt(btc, t - momentumDays * DAY);
          if (then == null || !(then > 0) || !(now > 0) || btcNow == null || btcThen == null || !(btcThen > 0)) continue;
          const score = (now / btcNow) / (then / btcThen) - 1;
          if (score > bestScore) {
            bestScore = score;
            best = i;
          }
        }
        if (best < 0 || !(bestScore > 0)) {
          return assets.map((asset) => ({ symbol: asset.symbol, weight: 0, sellLocked: false }));
        }
        const raw = assets.map(() => 0);
        raw[best] = 1;
        return allocate(assets, raw, spec.floorWeight ?? 0);
      }
      if (spec.riskOff === "cash") {
        if (spec.cashWhenWeak) {
          let hot = false;
          for (const i of coins) {
            const average = smaBefore(series[assets[i].symbol], dayIndex, trendDays);
            if (average != null && price[i] > average) {
              hot = true;
              break;
            }
          }
          if (hot) {
            // A selected coin is still trending, so the leader rule below keeps it.
          } else {
            return assets.map((asset) => ({ symbol: asset.symbol, weight: 0, sellLocked: false }));
          }
        } else {
          return assets.map((asset) => ({ symbol: asset.symbol, weight: 0, sellLocked: false }));
        }
      } else return "stay";
    } else if (spec.riskOn === "mix") return userMix();
  } else if (spec.regime && spec.regime !== "above-only") {
    let down = false;
    if (spec.regime === "btc-mix" || spec.regime === "btc-stay") {
      const px = closeAt(btc, t);
      const flag = px == null ? null : aboveAverage(btc, px);
      down = flag === false;
    } else {
      let known = 0;
      let above = 0;
      for (const i of coins) {
        const flag = aboveAverage(series[assets[i].symbol], price[i]);
        if (flag == null) continue;
        known += 1;
        if (flag) above += 1;
      }
      if (known > 0) {
        down = spec.regime.startsWith("alldown") ? above === 0 : above * 2 <= known;
      }
    }
    if (down) {
      if (spec.regime.endsWith("stay")) return "stay";
      return userMix();
    }
  }

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

  if (spec.regime === "above-only") {
    const hot: number[] = [];
    for (const i of coins) {
      if (aboveAverage(series[assets[i].symbol], price[i]) === true) hot.push(i);
    }
    if (hot.length === 0) return userMix();
    let leader = hot[0];
    let leaderScore = -Infinity;
    for (const i of hot) {
      const then = closeAt(series[assets[i].symbol], t - momentumDays * DAY);
      const now = price[i];
      const score = then != null && then > 0 ? now / then - 1 : -Infinity;
      if (score > leaderScore) {
        leaderScore = score;
        leader = i;
      }
    }
    const raw = assets.map(() => 0);
    if (usdtIndex >= 0) {
      let typedSum = 0;
      for (const i of tradable) typedSum += assets[i].weight;
      const typed = (i: number) => (typedSum > 0 ? assets[i].weight / typedSum : 0);
      let usdtW = typed(usdtIndex);
      for (const i of coins) if (!hot.includes(i)) usdtW += typed(i);
      const risk = Math.max(0, 1 - usdtW);
      raw[usdtIndex] = usdtW;
      if (hot.length === 1) raw[hot[0]] = risk;
      else {
        const rest = (1 - leaderWeight) / (hot.length - 1);
        for (const i of hot) raw[i] = risk * (i === leader ? leaderWeight : rest);
      }
    } else {
      const share = hot.length === 1 ? 1 : leaderWeight;
      const rest = hot.length === 1 ? 0 : (1 - share) / (hot.length - 1);
      for (const i of hot) raw[i] = i === leader ? share : rest;
    }
    return allocate(assets, raw, spec.floorWeight ?? 0);
  }

  if (usdtIndex >= 0) {
    if (qualifying.length === 0 || best < 0) {
      const raw = assets.map(() => 0);
      raw[usdtIndex] = 1;
      return allocate(assets, raw, spec.floorWeight ?? 0);
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
    return allocate(assets, raw, spec.floorWeight ?? 0);
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
      return allocate(assets, raw, spec.floorWeight ?? 0);
    }
    return userMix();
  }
  const share = coins.length === 1 ? 1 : leaderWeight;
  const rest = coins.length === 1 ? 0 : (1 - share) / (coins.length - 1);
  const raw = assets.map(() => 0);
  for (const i of coins) raw[i] = i === leader ? share : rest;
  return allocate(assets, raw, spec.floorWeight ?? 0);
}
