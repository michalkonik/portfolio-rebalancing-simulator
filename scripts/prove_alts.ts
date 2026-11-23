import { readFileSync, writeFileSync } from "node:fs";
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
const books: Array<{ group: string; coins: string[] }> = [];
for (const id of ["two-altcoins", "three-altcoins"]) {
  for (const coins of file.groups.find((item) => item.id === id)?.portfolios ?? []) books.push({ group: id, coins });
}
const windows = JSON.parse(readFileSync("results/windows-5000.json", "utf8")) as Window[];
const spec: IntelligentSpec = {
  enabled: true,
  score: "absolute",
  momentumDays: 30,
  trendDays: 50,
  leaderWeight: 0.8,
  defense: "equal",
  regime: "cowen",
  riskOff: "cash",
  btcMaDays: 200,
  btcFastMaDays: 0,
  dominanceMaDays: 50,
  totalMaDays: 50,
};

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

function run(coins: string[], start: number, end: number, intelligent: IntelligentSpec | null) {
  const series: Record<string, CandleSeries> = {
    BTC: load("BTC"),
    BTCD: load("BTCD"),
    TOTAL: load("TOTAL"),
  };
  for (const symbol of coins) series[symbol] = load(symbol);
  return simulate({
    assets: coins.map((symbol) => ({ symbol, weight: 1 })),
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
    intelligent: intelligent ?? undefined,
  });
}

let n = 0;
let both = 0;
let hold = 0;
let plain = 0;
let bullN = 0;
let bullBoth = 0;
let bearN = 0;
let bearBoth = 0;
let skipped = 0;
const perWindow: number[] = new Array(windows.length).fill(0);
const perWindowN: number[] = new Array(windows.length).fill(0);
const started = Date.now();
console.log(`books ${books.length} windows ${windows.length}`);

for (let w = 0; w < windows.length; w++) {
  const window = windows[w];
  for (const book of books) {
    const intel = run(book.coins, window.start, window.end, spec);
    const plainRun = run(book.coins, window.start, window.end, null);
    if (!intel.ok || !plainRun.ok) {
      skipped += 1;
      continue;
    }
    n += 1;
    perWindowN[w] += 1;
    const aheadHold = intel.summary.finalEquity > intel.summary.holdFinal + 0.01;
    const aheadPlain = intel.summary.finalEquity > plainRun.summary.finalEquity + 0.01;
    if (aheadHold) hold += 1;
    if (aheadPlain) plain += 1;
    const win = aheadHold && aheadPlain;
    if (win) {
      both += 1;
      perWindow[w] += 1;
    }
    if (window.bull) {
      bullN += 1;
      if (win) bullBoth += 1;
    } else {
      bearN += 1;
      if (win) bearBoth += 1;
    }
  }
  if ((w + 1) % 100 === 0 || w === windows.length - 1) {
    const pct = (num: number, den: number) => (den ? (100 * num) / den : 0);
    const line = `windows ${w + 1}/${windows.length} both ${pct(both, n).toFixed(2)} bull ${pct(bullBoth, bullN).toFixed(2)} bear ${pct(bearBoth, bearN).toFixed(2)} n ${n} skip ${skipped} ${((Date.now() - started) / 60000).toFixed(1)}min`;
    console.log(line);
    writeFileSync(
      "results/alts-5000-summary.json",
      JSON.stringify({
        updated: new Date().toISOString(),
        doneWindows: w + 1,
        windows: windows.length,
        books: books.length,
        n,
        skipped,
        both,
        hold,
        plain,
        bothRate: n ? both / n : 0,
        holdRate: n ? hold / n : 0,
        plainRate: n ? plain / n : 0,
        bullN,
        bullBoth,
        bullRate: bullN ? bullBoth / bullN : 0,
        bearN,
        bearBoth,
        bearRate: bearN ? bearBoth / bearN : 0,
        spec,
      }),
    );
  }
}
console.log("DONE");
