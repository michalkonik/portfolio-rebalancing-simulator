import type { CandleSeries } from "./types.ts";

const DAY = 86_400_000;

export interface DailyReturn {
  day: number;
  ret: number;
}

/**
 * Log returns of UTC-daily closes inside the window.
 * The last close before `startMs` is kept so the first day has a prior price.
 */
export function dailyLogReturns(series: CandleSeries, startMs: number, endMs: number): DailyReturn[] {
  let seedDay = -1;
  let seedClose = 0;
  const days: number[] = [];
  const closes: number[] = [];
  for (let i = 0; i < series.t.length; i++) {
    const ts = series.t[i];
    if (ts > endMs) break;
    const close = series.c[i];
    if (!(close > 0)) continue;
    const day = Math.floor(ts / DAY);
    if (ts < startMs) {
      seedDay = day;
      seedClose = close;
      continue;
    }
    if (days.length === 0 && seedClose > 0) {
      days.push(seedDay);
      closes.push(seedClose);
    }
    if (days.length === 0 || days[days.length - 1] !== day) {
      days.push(day);
      closes.push(close);
    } else {
      closes[closes.length - 1] = close;
    }
  }
  const out: DailyReturn[] = [];
  for (let i = 1; i < days.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (!(prev > 0) || !(cur > 0)) continue;
    out.push({ day: days[i], ret: Math.log(cur / prev) });
  }
  return out;
}

export function pearson(x: number[], y: number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 5) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx <= 0 || dy <= 0) return null;
  return num / Math.sqrt(dx * dy);
}

export interface PairCorrelation {
  observations: number;
  all: number | null;
  btcUp: number | null;
  btcDown: number | null;
}

function align(a: DailyReturn[], b: DailyReturn[], gate: DailyReturn[] | null): { x: number[]; y: number[]; g: number[] } {
  const ib = new Map<number, number>();
  for (const row of b) ib.set(row.day, row.ret);
  const ig = new Map<number, number>();
  if (gate) for (const row of gate) ig.set(row.day, row.ret);
  const x: number[] = [];
  const y: number[] = [];
  const g: number[] = [];
  for (const row of a) {
    const br = ib.get(row.day);
    if (br === undefined) continue;
    x.push(row.ret);
    y.push(br);
    g.push(gate ? ig.get(row.day) ?? Number.NaN : Number.NaN);
  }
  return { x, y, g };
}

/** Pearson correlation of daily log returns, plus the same split by the sign of BTC's day. */
export function pairCorrelation(
  left: CandleSeries,
  right: CandleSeries,
  btc: CandleSeries | null,
  startMs: number,
  endMs: number,
): PairCorrelation {
  const a = dailyLogReturns(left, startMs, endMs);
  const b = dailyLogReturns(right, startMs, endMs);
  const g = btc ? dailyLogReturns(btc, startMs, endMs) : null;
  const aligned = align(a, b, g);
  const upX: number[] = [];
  const upY: number[] = [];
  const dnX: number[] = [];
  const dnY: number[] = [];
  for (let i = 0; i < aligned.x.length; i++) {
    const sign = aligned.g[i];
    if (!(sign > 0) && !(sign < 0)) continue;
    if (sign > 0) {
      upX.push(aligned.x[i]);
      upY.push(aligned.y[i]);
    } else {
      dnX.push(aligned.x[i]);
      dnY.push(aligned.y[i]);
    }
  }
  return {
    observations: aligned.x.length,
    all: pearson(aligned.x, aligned.y),
    btcUp: pearson(upX, upY),
    btcDown: pearson(dnX, dnY),
  };
}

export interface Matrix {
  symbols: string[];
  observations: number[][];
  all: (number | null)[][];
  btcUp: (number | null)[][];
  btcDown: (number | null)[][];
}

export function correlationMatrix(
  series: CandleSeries[],
  btc: CandleSeries | null,
  startMs: number,
  endMs: number,
): Matrix {
  const n = series.length;
  const symbols = series.map((s) => s.symbol);
  const all = Array.from({ length: n }, () => Array<number | null>(n).fill(null));
  const btcUp = Array.from({ length: n }, () => Array<number | null>(n).fill(null));
  const btcDown = Array.from({ length: n }, () => Array<number | null>(n).fill(null));
  const observations = Array.from({ length: n }, () => Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    all[i][i] = 1;
    btcUp[i][i] = 1;
    btcDown[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const pair = pairCorrelation(series[i], series[j], btc, startMs, endMs);
      all[i][j] = all[j][i] = pair.all;
      btcUp[i][j] = btcUp[j][i] = pair.btcUp;
      btcDown[i][j] = btcDown[j][i] = pair.btcDown;
      observations[i][j] = observations[j][i] = pair.observations;
    }
  }
  return { symbols, observations, all, btcUp, btcDown };
}
