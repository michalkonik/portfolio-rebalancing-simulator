/** Path statistics. Returns are decimals (0.1 = 10%). */

const DAY = 86_400_000;
const YEAR = 365.25 * DAY;

export interface PathStats {
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  volatility: number;
  sharpe: number;
  sortino: number;
  calmar: number;
}

export function maxDrawdown(equity: ArrayLike<number>): number {
  let peak = 0;
  let worst = 0;
  for (let i = 0; i < equity.length; i++) {
    const v = equity[i];
    if (!(v > 0)) continue;
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = v / peak - 1;
      if (dd < worst) worst = dd;
    }
  }
  return worst;
}

export function pathStats(
  equity: ArrayLike<number>,
  time: ArrayLike<number>,
  initialUsdt: number,
): PathStats {
  const n = equity.length;
  const empty: PathStats = {
    totalReturn: 0,
    cagr: 0,
    maxDrawdown: 0,
    volatility: 0,
    sharpe: 0,
    sortino: 0,
    calmar: 0,
  };
  if (n === 0 || !(initialUsdt > 0)) return empty;
  const finalEq = equity[n - 1];
  const totalReturn = finalEq / initialUsdt - 1;
  const elapsed = time[n - 1] - time[0];
  const cagr = elapsed > 0 && finalEq > 0 ? (finalEq / initialUsdt) ** (YEAR / elapsed) - 1 : 0;
  const dd = maxDrawdown(equity);

  let sum = 0;
  let sum2 = 0;
  let down2 = 0;
  let count = 0;
  let dtSum = 0;
  let dtCount = 0;
  for (let i = 1; i < n; i++) {
    const prev = equity[i - 1];
    const cur = equity[i];
    const dt = time[i] - time[i - 1];
    if (!(prev > 0) || !(cur > 0) || !(dt > 0)) continue;
    const r = Math.log(cur / prev);
    sum += r;
    sum2 += r * r;
    if (r < 0) down2 += r * r;
    count += 1;
    dtSum += dt;
    dtCount += 1;
  }
  if (count < 2 || dtCount === 0) {
    return { ...empty, totalReturn, cagr, maxDrawdown: dd, calmar: dd < 0 ? cagr / Math.abs(dd) : 0 };
  }
  const mean = sum / count;
  const variance = Math.max(0, (sum2 - count * mean * mean) / (count - 1));
  const std = Math.sqrt(variance);
  const downside = Math.sqrt(down2 / (count - 1));
  const medianDt = dtSum / dtCount;
  const ann = Math.sqrt(YEAR / medianDt);
  const volatility = std * ann;
  const sharpe = std > 0 ? (mean / std) * ann : 0;
  const sortino = downside > 0 ? (mean / downside) * ann : 0;
  const calmar = dd < 0 ? cagr / Math.abs(dd) : 0;
  return { totalReturn, cagr, maxDrawdown: dd, volatility, sharpe, sortino, calmar };
}
