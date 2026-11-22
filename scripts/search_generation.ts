import { appendFileSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseCandleCsv } from "../engine/csv.ts";
import { simulate } from "../engine/simulate.ts";
import type { CandleSeries, IntelligentSpec } from "../engine/types.ts";

interface FileShape {
  groups: Array<{ id: string; portfolios: string[][] }>;
}
interface WindowRow {
  name: string;
  start: number;
  end: number;
  bull: boolean;
}

const generation = process.argv[2] ?? "g1-basket";
const file = JSON.parse(readFileSync("/home/mkoniu/Desktop/rebalance-portfolios.json", "utf8")) as FileShape;
const books: string[][] = [];
for (const id of ["two-altcoins", "three-altcoins"]) {
  file.groups.find((item) => item.id === id)?.portfolios.forEach((row, index) => {
    if (index % 11 === 0) books.push(row);
  });
}
const windows = (JSON.parse(readFileSync("results/windows-5000.json", "utf8")) as WindowRow[]).filter(
  (_, index) => index % 25 === 0,
);
const cache = new Map<string, CandleSeries>();
function load(symbol: string): CandleSeries {
  const got = cache.get(symbol);
  if (got) return got;
  const raw = gunzipSync(readFileSync(`docs/data/candles/${symbol}.csv.gz`));
  const parsed = parseCandleCsv(raw.toString("utf8"), symbol);
  cache.set(symbol, parsed);
  return parsed;
}
load("BTC");
load("BTCD");
load("TOTAL");

const common = {
  enabled: true,
  score: "absolute" as const,
  momentumDays: 30,
  trendDays: 50,
  leaderWeight: 0.8,
  defense: "equal" as const,
  regime: "cowen" as const,
  btcMaDays: 200,
  dominanceMaDays: 50,
  totalMaDays: 50,
  cashOnBasketDown: true,
};

const grids: Record<string, Array<[string, IntelligentSpec]>> = {
  "g1-basket": [
    ["basket30", { ...common, cashOnBasketDown: true, basketDays: 30, basketHurdle: 0 }],
    ["basket60", { ...common, cashOnBasketDown: true, basketDays: 60, basketHurdle: 0 }],
    ["basket90", { ...common, cashOnBasketDown: true, basketDays: 90, basketHurdle: 0 }],
    ["basket30-hurdle-5", { ...common, cashOnBasketDown: true, basketDays: 30, basketHurdle: -0.05 }],
    ["basket60-hurdle-10", { ...common, cashOnBasketDown: true, basketDays: 60, basketHurdle: -0.1 }],
    ["basket30-dom-off", { ...common, cashOnBasketDown: true, basketDays: 30, basketHurdle: 0, dominanceMaDays: 0, totalMaDays: 0, btcMaDays: 0 }],
  ],
  "g3-confirm": [
    ["confirm14", { ...common, cashOnBasketDown: false, riskOff: "cash", cashConfirmDays: 14 }],
    ["confirm30", { ...common, cashOnBasketDown: false, riskOff: "cash", cashConfirmDays: 30 }],
    ["confirm60", { ...common, cashOnBasketDown: false, riskOff: "cash", cashConfirmDays: 60 }],
    ["confirm90", { ...common, cashOnBasketDown: false, riskOff: "cash", cashConfirmDays: 90 }],
  ],
  "g2-vsbtc": [
    ["vsbtc-200-50-50", { ...common, cashOnBasketDown: false, riskOff: "vsbtc" }],
    ["vsbtc-dom50", { ...common, cashOnBasketDown: false, riskOff: "vsbtc", btcMaDays: 0, totalMaDays: 0, dominanceMaDays: 50 }],
    ["vsbtc-btc200", { ...common, cashOnBasketDown: false, riskOff: "vsbtc", btcMaDays: 200, dominanceMaDays: 0, totalMaDays: 0 }],
    ["vsbtc-m90", { ...common, cashOnBasketDown: false, riskOff: "vsbtc", momentumDays: 90 }],
  ],
};
const grid = grids[generation];
if (!grid) throw new Error(`unknown generation ${generation}`);

function run(symbols: string[], start: number, end: number, spec: IntelligentSpec | null) {
  const series: Record<string, CandleSeries> = {
    BTC: load("BTC"),
    BTCD: load("BTCD"),
    TOTAL: load("TOTAL"),
  };
  for (const symbol of symbols) series[symbol] = load(symbol);
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

console.log(`generation ${generation} books ${books.length} windows ${windows.length}`);
for (const [name, spec] of grid) {
  const started = Date.now();
  let n = 0;
  let both = 0;
  let holdN = 0;
  let plainN = 0;
  let bullBoth = 0;
  let bullN = 0;
  let bearBoth = 0;
  let bearN = 0;
  for (const book of books) {
    for (const window of windows) {
      const intel = run(book, window.start, window.end, spec);
      const plainRun = run(book, window.start, window.end, null);
      if (!intel.ok || !plainRun.ok) continue;
      n += 1;
      const winHold = intel.summary.finalEquity > intel.summary.holdFinal + 0.01;
      const winPlain = intel.summary.finalEquity > plainRun.summary.finalEquity + 0.01;
      if (winHold) holdN += 1;
      if (winPlain) plainN += 1;
      const win = winHold && winPlain;
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
  const row = {
    at: new Date().toISOString(),
    generation,
    name,
    n,
    bothRate: n ? both / n : 0,
    holdRate: n ? holdN / n : 0,
    plainRate: n ? plainN / n : 0,
    bullRate: bullN ? bullBoth / bullN : 0,
    bearRate: bearN ? bearBoth / bearN : 0,
    seconds: (Date.now() - started) / 1000,
    spec,
  };
  appendFileSync("results/alts-search-log.jsonl", `${JSON.stringify(row)}\n`);
  const pct = (value: number) => (100 * value).toFixed(1);
  console.log(
    `${name} both ${pct(row.bothRate)} hold ${pct(row.holdRate)} plain ${pct(row.plainRate)} bull ${pct(row.bullRate)} bear ${pct(row.bearRate)} n ${n} ${row.seconds.toFixed(0)}s`,
  );
}
