import { appendFileSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseCandleCsv } from "../engine/csv.ts";
import { simulate } from "../engine/simulate.ts";
import type { CandleSeries, IntelligentSpec } from "../engine/types.ts";

interface FileShape { groups: Array<{ id: string; portfolios: string[][] }> }
interface WindowRow { start: number; end: number; bull: boolean }
const DAY = 86_400_000;
const file = JSON.parse(readFileSync("/home/mkoniu/Desktop/rebalance-portfolios.json", "utf8")) as FileShape;
const books: string[][] = [];
for (const id of ["two-altcoins", "three-altcoins"]) {
  file.groups.find((g) => g.id === id)?.portfolios.forEach((row, i) => { if (i % 11 === 0) books.push(row); });
}
const windows = (JSON.parse(readFileSync("results/windows-5000.json", "utf8")) as WindowRow[]).filter((_, i) => i % 25 === 0);
const cache = new Map<string, CandleSeries>();
function load(symbol: string): CandleSeries {
  const got = cache.get(symbol);
  if (got) return got;
  const parsed = parseCandleCsv(gunzipSync(readFileSync(`docs/data/candles/${symbol}.csv.gz`)).toString("utf8"), symbol);
  cache.set(symbol, parsed);
  return parsed;
}
function closeAt(series: CandleSeries, t: number): number | null {
  let lo = 0, hi = series.t.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.t[mid] <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return idx < 0 ? null : series.c[idx];
}
function ret(symbol: string, a: number, b: number): number | null {
  const x = closeAt(load(symbol), a), y = closeAt(load(symbol), b);
  if (x == null || y == null || !(x > 0) || !(y > 0)) return null;
  return y / x - 1;
}
const kept: IntelligentSpec = {
  enabled: true, score: "absolute", momentumDays: 30, trendDays: 50, leaderWeight: 0.8,
  defense: "equal", regime: "cowen", riskOff: "cash", btcMaDays: 200, dominanceMaDays: 50, totalMaDays: 50,
};
const cash: IntelligentSpec = { ...kept, btcMaDays: 5000, dominanceMaDays: 0, totalMaDays: 0 };
const equal: IntelligentSpec = { ...cash, riskOff: "mix" };
const leader: IntelligentSpec = { ...kept, btcMaDays: 0, dominanceMaDays: 0, totalMaDays: 0, riskOff: "stay" };
const specs = { kept, cash, equal, leader };

function run(symbols: string[], start: number, end: number, spec: IntelligentSpec | null) {
  const series: Record<string, CandleSeries> = { BTC: load("BTC"), BTCD: load("BTCD"), TOTAL: load("TOTAL") };
  for (const symbol of symbols) series[symbol] = load(symbol);
  return simulate({
    assets: symbols.map((symbol) => ({ symbol, weight: 1 })),
    series, btc: series.BTC, startMs: start, endMs: end, initialUsdt: 10_000,
    feeBps: 10, slippageBps: 5, frequency: "custom", everyDays: 14, weekday: 1,
    band: 0, fraction: 1, trend: { enabled: false, smaDays: 50 }, blockedBuyPolicy: "keep_winners",
    intelligent: spec ?? undefined,
  });
}

interface Row {
  bull: boolean;
  btc: number;
  dom: number;
  total: number;
  basket: number;
  pass: Record<string, boolean>;
}
const rows: Row[] = [];
const t0 = Date.now();
for (const coins of books) {
  for (const window of windows) {
    const plain = run(coins, window.start, window.end, null);
    if (!plain.ok) continue;
    const pass: Record<string, boolean> = {};
    let ok = true;
    for (const [name, spec] of Object.entries(specs)) {
      const intel = run(coins, window.start, window.end, spec);
      if (!intel.ok) { ok = false; break; }
      pass[name] = intel.summary.finalEquity > intel.summary.holdFinal + 0.01
        && intel.summary.finalEquity > plain.summary.finalEquity + 0.01;
    }
    if (!ok) continue;
    const a = window.start - 90 * DAY;
    const basketRets = coins.map((symbol) => ret(symbol, a, window.start)).filter((v): v is number => v != null);
    const dom0 = ret("BTCD", a, window.start);
    const btc0 = ret("BTC", a, window.start);
    const total0 = ret("TOTAL", a, window.start);
    if (btc0 == null || dom0 == null || total0 == null || basketRets.length === 0) continue;
    rows.push({
      bull: window.bull,
      btc: btc0,
      dom: dom0,
      total: total0,
      basket: basketRets.reduce((s, v) => s + v, 0) / basketRets.length,
      pass,
    });
  }
}
console.log(`rows ${rows.length} cached in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

function report(name: string, pick: (row: Row) => string) {
  let n = 0, both = 0, bullN = 0, bullBoth = 0, bearN = 0, bearBoth = 0;
  for (const row of rows) {
    n += 1;
    const win = row.pass[pick(row)] === true;
    if (win) both += 1;
    if (row.bull) { bullN += 1; if (win) bullBoth += 1; }
    else { bearN += 1; if (win) bearBoth += 1; }
  }
  const out = {
    at: new Date().toISOString(), generation: "g5-router", name, n,
    bothRate: both / n, bullRate: bullBoth / bullN, bearRate: bearBoth / bearN,
  };
  appendFileSync("results/alts-search-log.jsonl", `${JSON.stringify(out)}\n`);
  console.log(`${name} both ${(100 * out.bothRate).toFixed(1)} bull ${(100 * out.bullRate).toFixed(1)} bear ${(100 * out.bearRate).toFixed(1)}`);
  return out.bothRate;
}

let best = 0;
let bestName = "";
for (const btcCut of [-0.2, -0.05, 0, 0.05, 0.2]) {
  for (const domCut of [-0.02, 0, 0.02]) {
    for (const basketCut of [-0.1, 0, 0.1]) {
      const name = `btc${btcCut}-dom${domCut}-basket${basketCut}`;
      const rate = report(name, (row) => {
        if (row.basket < basketCut || row.btc < btcCut) return "cash";
        if (row.dom > domCut && row.btc > 0) return "leader";
        return "kept";
      });
      if (rate > best) { best = rate; bestName = name; }
    }
  }
}
console.log(`best router ${bestName} ${(100 * best).toFixed(1)}`);
