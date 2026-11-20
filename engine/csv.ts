import type { CandleSeries } from "./types.ts";

/** Parse a candle CSV (header t,o,h,l,c,v). Ignores blank lines. */
export function parseCandleCsv(text: string, symbol: string): CandleSeries {
  const lines = text.split(/\r?\n/);
  const t: number[] = [];
  const o: number[] = [];
  const c: number[] = [];
  let previous = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("t,") || line.startsWith("t\t")) continue;
    const parts = line.split(",");
    if (parts.length < 5) continue;
    const ts = Number(parts[0]);
    const open = Number(parts[1]);
    const close = Number(parts[4]);
    if (!Number.isFinite(ts) || !Number.isFinite(open) || !Number.isFinite(close)) continue;
    if (close <= 0 || open <= 0) continue;
    if (ts <= previous) continue;
    previous = ts;
    t.push(ts);
    o.push(open);
    c.push(close);
  }
  return { symbol, t, o, c };
}
