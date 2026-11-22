import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseCandleCsv } from "../engine/csv.ts";
import { simulate } from "../engine/simulate.ts";
import type { CandleSeries, IntelligentSpec } from "../engine/types.ts";

interface FileShape {
  groups: Array<{ id: string; portfolios: string[][] }>;
}

const file = JSON.parse(readFileSync("/home/mkoniu/Desktop/rebalance-portfolios.json", "utf8")) as FileShape;
const books: string[][] = [];
for (const id of ["two-altcoins", "three-altcoins"]) {
  const group = file.groups.find((item) => item.id === id);
  group?.portfolios.forEach((row, index) => {
    if (index % 11 === 0) books.push(row);
  });
}

const cache = new Map<string, CandleSeries>();
function load(symbol: string): CandleSeries {
  const got = cache.get(symbol);
  if (got) return got;
  const raw = gunzipSync(readFileSync(`docs/data/candles/${symbol}.csv.gz`));
  const parsed = parseCandleCsv(raw.toString("utf8"), symbol);
  cache.set(symbol, parsed);
  return parsed;
}

const btc = load("BTC");
const dominance = load("BTCD");
const total = load("TOTAL");

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

const minStart = Date.UTC(2022, 2, 1);
const maxEnd = Date.UTC(2026, 10, 20, 23, 59, 59);
const lengths = [90, 120, 180, 270, 365, 540];
const windows: Array<{ name: string; start: number; end: number; bull: boolean }> = [];
let seed = 20261122;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const bull: typeof windows = [];
const bear: typeof windows = [];
let guard = 0;
while ((bull.length < 2500 || bear.length < 2500) && guard < 200000) {
  guard += 1;
  const length = lengths[Math.floor(rand() * lengths.length)];
  const span = maxEnd - minStart - length * 86_400_000;
  const start = minStart + Math.floor(rand() * span);
  const end = start + length * 86_400_000;
  const a = closeAt(btc, start);
  const b = closeAt(btc, end);
  if (a == null || b == null || a <= 0) continue;
  const up = b > a;
  const bucket = up ? bull : bear;
  if (bucket.length >= 2500) continue;
  bucket.push({ name: `${up ? "bull" : "bear"}-${bucket.length}`, start, end, bull: up });
}
windows.push(...bull, ...bear);
writeFileSync("results/windows-5000.json", JSON.stringify(windows));
console.log(`windows ${windows.length} bull ${bull.length} bear ${bear.length} books ${books.length}`);

const common = {
  enabled: true,
  score: "absolute" as const,
  momentumDays: 30,
  trendDays: 50,
  leaderWeight: 0.8,
  defense: "equal" as const,
};

const grid: Array<[string, IntelligentSpec]> = [
  ["v1-mix100", { ...common, regime: "btc-mix", regimeDays: 100 }],
  ["cowen-200-50-50-stay", { ...common, regime: "cowen", btcMaDays: 200, dominanceMaDays: 50, totalMaDays: 50, riskOff: "stay" }],
  ["cowen-140-50-50-stay", { ...common, regime: "cowen", btcMaDays: 140, btcFastMaDays: 50, dominanceMaDays: 50, totalMaDays: 50, riskOff: "stay" }],
  ["cowen-200-100-100-mix", { ...common, regime: "cowen", btcMaDays: 200, dominanceMaDays: 100, totalMaDays: 100, riskOff: "mix" }],
  ["cowen-100-30-20-stay", { ...common, regime: "cowen", btcMaDays: 100, dominanceMaDays: 30, totalMaDays: 20, riskOff: "stay", leaderWeight: 1 }],
  ["cowen-dom50", { ...common, regime: "cowen", dominanceMaDays: 50, riskOff: "stay" }],
  ["cowen-total50", { ...common, regime: "cowen", totalMaDays: 50, riskOff: "stay" }],
  ["cowen-btc200", { ...common, regime: "cowen", btcMaDays: 200, riskOff: "stay" }],
  ["cowen-200-50-50-mix", { ...common, regime: "cowen", btcMaDays: 200, dominanceMaDays: 50, totalMaDays: 50, riskOff: "mix" }],
  ["cowen-m90", { ...common, regime: "cowen", btcMaDays: 200, btcFastMaDays: 140, dominanceMaDays: 90, totalMaDays: 50, momentumDays: 90, trendDays: 100, riskOff: "stay" }],
];

const sampleWindows = windows.filter((_, index) => index % 25 === 0);
console.log(`search windows ${sampleWindows.length}`);

function run(symbols: string[], start: number, end: number, spec: IntelligentSpec | null) {
  const series: Record<string, CandleSeries> = { BTCD: dominance, TOTAL: total };
  for (const symbol of new Set([...symbols, "BTC"])) {
    series[symbol] = load(symbol);
  }
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

for (const [name, spec] of grid) {
  const started = Date.now();
  let n = 0;
  let both = 0;
  let hold = 0;
  let plain = 0;
  let bullBoth = 0;
  let bullN = 0;
  let bearBoth = 0;
  let bearN = 0;
  for (const book of books) {
    for (const window of sampleWindows) {
      const intel = run(book, window.start, window.end, spec);
      const plainRun = run(book, window.start, window.end, null);
      if (!intel.ok || !plainRun.ok) continue;
      n += 1;
      const finalEquity = intel.summary.finalEquity;
      const holdFinal = intel.summary.holdFinal;
      const plainFinal = plainRun.summary.finalEquity;
      const aheadHold = finalEquity > holdFinal + 0.01;
      const aheadPlain = finalEquity > plainFinal + 0.01;
      if (aheadHold) hold += 1;
      if (aheadPlain) plain += 1;
      if (aheadHold && aheadPlain) both += 1;
      if (window.bull) {
        bullN += 1;
        if (aheadHold && aheadPlain) bullBoth += 1;
      } else {
        bearN += 1;
        if (aheadHold && aheadPlain) bearBoth += 1;
      }
    }
  }
  const pct = (num: number, den: number) => (den ? ((100 * num) / den).toFixed(1) : "0");
  console.log(
    `${name} both ${pct(both, n)} hold ${pct(hold, n)} plain ${pct(plain, n)} bull ${pct(bullBoth, bullN)} bear ${pct(bearBoth, bearN)} n ${n} ${((Date.now() - started) / 1000).toFixed(0)}s`,
  );
}
