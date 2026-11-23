import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseCandleCsv } from "../engine/csv.ts";
import { simulate } from "../engine/simulate.ts";
import type { CandleSeries, IntelligentSpec } from "../engine/types.ts";

interface FileShape {
  groups: Array<{ id: string; portfolios: string[][] }>;
}
interface Window {
  name: string;
  start: number;
  end: number;
  bull: boolean;
}

const file = JSON.parse(readFileSync("/home/mkoniu/Desktop/rebalance-portfolios.json", "utf8")) as FileShape;
const books: string[][] = [];
for (const id of ["two-altcoins", "three-altcoins"]) {
  file.groups.find((item) => item.id === id)?.portfolios.forEach((row, index) => {
    if (index % 11 === 0) books.push(row);
  });
}
const windows = (JSON.parse(readFileSync("results/windows-5000.json", "utf8")) as Window[]).filter((_, index) => index % 25 === 0);

const cache = new Map<string, CandleSeries>();
function load(symbol: string): CandleSeries {
  const got = cache.get(symbol);
  if (got) return got;
  const raw = gunzipSync(readFileSync(`docs/data/candles/${symbol}.csv.gz`));
  const parsed = parseCandleCsv(raw.toString("utf8"), symbol);
  cache.set(symbol, parsed);
  return parsed;
}
const dominance = load("BTCD");
const total = load("TOTAL");

const common = {
  enabled: true,
  score: "absolute" as const,
  momentumDays: 30,
  trendDays: 50,
  leaderWeight: 0.8,
  defense: "equal" as const,
  regime: "cowen" as const,
  riskOff: "cash" as const,
};

const grid: Array<[string, IntelligentSpec]> = [
  ["weak-all", { ...common, cashWhenWeak: true, btcMaDays: 200, dominanceMaDays: 50, totalMaDays: 50 }],
  ["weak-total50", { ...common, cashWhenWeak: true, totalMaDays: 50 }],
  ["weak-dom50", { ...common, cashWhenWeak: true, dominanceMaDays: 50 }],
  ["weak-btc200", { ...common, cashWhenWeak: true, btcMaDays: 200 }],
  ["weak-total100-dom50", { ...common, cashWhenWeak: true, totalMaDays: 100, dominanceMaDays: 50 }],
  ["weak-all-m90", { ...common, cashWhenWeak: true, btcMaDays: 200, dominanceMaDays: 50, totalMaDays: 50, momentumDays: 90, trendDays: 100, leaderWeight: 1 }],
];

function run(symbols: string[], start: number, end: number, spec: IntelligentSpec | null) {
  const series: Record<string, CandleSeries> = { BTCD: dominance, TOTAL: total };
  for (const symbol of symbols) series[symbol] = load(symbol);
  series.BTC = load("BTC");
  return simulate({
    assets: symbols.map((symbol) => ({ symbol, weight: 1 })),
    series,
    btc: series.BTC,
    startMs: start,
    endMs: end,
    initialUsdt: 10_000,
    feeBps: 10,
    slippageBps: 5,
    frequency: "custom",
    everyDays: 14,
    weekday: 1,
    band: 0,
    fraction: 1,
    trend: { enabled: false, smaDays: 50 },
    blockedBuyPolicy: "keep_winners",
    intelligent: spec ?? undefined,
  });
}

console.log(`books ${books.length} windows ${windows.length}`);
for (const [name, spec] of grid) {
  const started = Date.now();
  let n = 0, both = 0, hold = 0, plain = 0, bullBoth = 0, bullN = 0, bearBoth = 0, bearN = 0;
  for (const book of books) {
    for (const window of windows) {
      const intel = run(book, window.start, window.end, spec);
      const plainRun = run(book, window.start, window.end, null);
      if (!intel.ok || !plainRun.ok) continue;
      n += 1;
      const aheadHold = intel.summary.finalEquity > intel.summary.holdFinal + 0.01;
      const aheadPlain = intel.summary.finalEquity > plainRun.summary.finalEquity + 0.01;
      if (aheadHold) hold += 1;
      if (aheadPlain) plain += 1;
      const win = aheadHold && aheadPlain;
      if (win) both += 1;
      if (window.bull) {
        bullN += 1;
        if (win) bullBoth += 1;
      } else {
        bearN += 1;
        if (win) bearBoth += 1;
      }
    }
  }
  const pct = (num: number, den: number) => (den ? ((100 * num) / den).toFixed(1) : "0");
  console.log(`${name} both ${pct(both, n)} hold ${pct(hold, n)} plain ${pct(plain, n)} bull ${pct(bullBoth, bullN)} bear ${pct(bearBoth, bearN)} n ${n} ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
