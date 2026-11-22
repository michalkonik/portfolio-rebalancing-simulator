import { appendFileSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseCandleCsv } from "../engine/csv.ts";
import { simulate } from "../engine/simulate.ts";
import type { CandleSeries, IntelligentSpec, SimResult } from "../engine/types.ts";

interface FileShape {
  groups: Array<{ id: string; portfolios: string[][] }>;
}
interface WindowRow {
  start: number;
  end: number;
  bull: boolean;
}

const DAY = 86_400_000;
const file = JSON.parse(readFileSync("/home/mkoniu/Desktop/rebalance-portfolios.json", "utf8")) as FileShape;
const books: string[][] = [];
for (const id of ["two-altcoins", "three-altcoins"]) {
  file.groups.find((item) => item.id === id)?.portfolios.forEach((row, index) => {
    if (index % 11 === 0) books.push(row);
  });
}
const windows = (JSON.parse(readFileSync("results/windows-5000.json", "utf8")) as WindowRow[]).filter((_, i) => i % 25 === 0);

const cache = new Map<string, CandleSeries>();
function load(symbol: string): CandleSeries {
  const got = cache.get(symbol);
  if (got) return got;
  const raw = gunzipSync(readFileSync(`docs/data/candles/${symbol}.csv.gz`));
  const parsed = parseCandleCsv(raw.toString("utf8"), symbol);
  cache.set(symbol, parsed);
  return parsed;
}
function closeAt(series: CandleSeries, t: number): number | null {
  let lo = 0;
  let hi = series.t.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.t[mid] <= t) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return idx < 0 ? null : series.c[idx];
}
function ret(symbol: string, a: number, b: number): number | null {
  const series = load(symbol);
  const x = closeAt(series, a);
  const y = closeAt(series, b);
  if (x == null || y == null || !(x > 0) || !(y > 0)) return null;
  return y / x - 1;
}

const kept: IntelligentSpec = {
  enabled: true, score: "absolute", momentumDays: 30, trendDays: 50, leaderWeight: 0.8,
  defense: "equal", regime: "cowen", riskOff: "cash", btcMaDays: 200, dominanceMaDays: 50, totalMaDays: 50,
};
const alwaysCash: IntelligentSpec = { ...kept, btcMaDays: 5000, dominanceMaDays: 0, totalMaDays: 0, cashConfirmDays: 0 };
const alwaysEqual: IntelligentSpec = { ...alwaysCash, riskOff: "mix" };
const pureLeader: IntelligentSpec = {
  ...kept, btcMaDays: 0, dominanceMaDays: 0, totalMaDays: 0, riskOff: "stay", cashConfirmDays: 0,
};

function run(symbols: string[], start: number, end: number, spec: IntelligentSpec | null): SimResult {
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

function score(name: string, choose: (coins: string[], start: number) => IntelligentSpec, lookback: number) {
  const started = Date.now();
  let n = 0, both = 0, bullN = 0, bullBoth = 0, bearN = 0, bearBoth = 0, holdN = 0, plainN = 0;
  for (const coins of books) {
    for (const window of windows) {
      const spec = choose(coins, window.start);
      const intel = run(coins, window.start, window.end, spec);
      const plain = run(coins, window.start, window.end, null);
      if (!intel.ok || !plain.ok) continue;
      n += 1;
      const winHold = intel.summary.finalEquity > intel.summary.holdFinal + 0.01;
      const winPlain = intel.summary.finalEquity > plain.summary.finalEquity + 0.01;
      if (winHold) holdN += 1;
      if (winPlain) plainN += 1;
      const win = winHold && winPlain;
      if (win) both += 1;
      if (window.bull) { bullN += 1; if (win) bullBoth += 1; }
      else { bearN += 1; if (win) bearBoth += 1; }
    }
  }
  const row = {
    at: new Date().toISOString(), generation: "g4-walkforward", name, lookback, n,
    bothRate: n ? both / n : 0, holdRate: n ? holdN / n : 0, plainRate: n ? plainN / n : 0,
    bullRate: bullN ? bullBoth / bullN : 0, bearRate: bearN ? bearBoth / bearN : 0,
    seconds: (Date.now() - started) / 1000,
  };
  appendFileSync("results/alts-search-log.jsonl", `${JSON.stringify(row)}\n`);
  const pct = (v: number) => (100 * v).toFixed(1);
  console.log(`${name} both ${pct(row.bothRate)} bull ${pct(row.bullRate)} bear ${pct(row.bearRate)} n ${n} ${row.seconds.toFixed(0)}s`);
}

function pastChoice(coins: string[], start: number, lookback: number): "cash" | "equal" | "leader" {
  const a = start - lookback * DAY;
  const rets: number[] = [];
  for (const symbol of coins) {
    const r = ret(symbol, a, start);
    if (r != null) rets.push(r);
  }
  const equal = rets.length ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  let bestMom = -Infinity;
  let leader = equal;
  for (const symbol of coins) {
    const mom = ret(symbol, a - 30 * DAY, a);
    const forward = ret(symbol, a, start);
    if (mom == null || forward == null) continue;
    if (mom > bestMom) {
      bestMom = mom;
      leader = forward;
    }
  }
  const cash = 0;
  if (cash >= equal && cash >= leader) return "cash";
  if (leader >= equal) return "leader";
  return "equal";
}

const specFor = { cash: alwaysCash, equal: alwaysEqual, leader: pureLeader, kept };

console.log(`books ${books.length} windows ${windows.length}`);
for (const lookback of [90, 180, 365]) {
  score(`wf-${lookback}`, (coins, start) => specFor[pastChoice(coins, start, lookback)], lookback);
  score(`wf-override-${lookback}`, (coins, start) => {
    const pick = pastChoice(coins, start, lookback);
    return pick === "leader" ? pureLeader : pick === "cash" ? alwaysCash : kept;
  }, lookback);
}

{
  const started = Date.now();
  let n = 0, both = 0, bullN = 0, bullBoth = 0, bearN = 0, bearBoth = 0;
  for (const coins of books) {
    for (const window of windows) {
      const plain = run(coins, window.start, window.end, null);
      if (!plain.ok) continue;
      let win = false;
      let holdSeen = false;
      for (const spec of [kept, alwaysCash, alwaysEqual, pureLeader]) {
        const intel = run(coins, window.start, window.end, spec);
        if (!intel.ok) continue;
        holdSeen = true;
        if (intel.summary.finalEquity > intel.summary.holdFinal + 0.01 && intel.summary.finalEquity > plain.summary.finalEquity + 0.01) win = true;
      }
      if (!holdSeen) continue;
      n += 1;
      if (win) both += 1;
      if (window.bull) { bullN += 1; if (win) bullBoth += 1; }
      else { bearN += 1; if (win) bearBoth += 1; }
    }
  }
  const row = {
    at: new Date().toISOString(), generation: "g4-oracle", name: "oracle-best-of-4", n,
    bothRate: n ? both / n : 0, bullRate: bullN ? bullBoth / bullN : 0, bearRate: bearN ? bearBoth / bearN : 0,
    seconds: (Date.now() - started) / 1000,
    note: "Ceiling if a switch could pick the best of the four rules after seeing the window. Not a tradable rule.",
  };
  appendFileSync("results/alts-search-log.jsonl", `${JSON.stringify(row)}\n`);
  const pct = (v: number) => (100 * v).toFixed(1);
  console.log(`oracle both ${pct(row.bothRate)} bull ${pct(row.bullRate)} bear ${pct(row.bearRate)} n ${n} ${row.seconds.toFixed(0)}s`);
}
