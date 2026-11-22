import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseCandleCsv } from "../engine/csv.ts";
import { simulate } from "../engine/simulate.ts";
import type { CandleSeries, IntelligentSpec, SimSuccess } from "../engine/types.ts";

const btc = parseCandleCsv(gunzipSync(readFileSync("docs/data/candles/BTC.csv.gz")).toString("utf8"), "BTC");
const eth = parseCandleCsv(gunzipSync(readFileSync("docs/data/candles/ETH.csv.gz")).toString("utf8"), "ETH");

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

interface Window {
  name: string;
  start: number;
  end: number;
  kind: "bull" | "bear";
}

const named: Array<[string, string, string, "bull" | "bear"]> = [
  ["2017-bull", "2017-08-17", "2017-12-16", "bull"],
  ["2018-bear", "2017-12-17", "2018-12-15", "bear"],
  ["2019-mixed", "2019-01-01", "2020-03-12", "bear"],
  ["2020-bull", "2020-03-13", "2021-11-08", "bull"],
  ["2022-bear", "2021-11-09", "2022-11-21", "bear"],
  ["2023-2024-bull", "2023-01-01", "2024-03-13", "bull"],
  ["2024-2026", "2024-03-14", "2026-11-20", "bull"],
  ["full-2017-2026", "2017-08-17", "2026-11-20", "bull"],
];

function ms(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

const windows: Window[] = named.map(([name, a, b, kind]) => ({ name, start: ms(a), end: ms(b) + 86_400_000 - 1, kind }));
const span = Math.round(3.5 * 365.25 * 86_400_000);
for (let start = ms("2017-08-17"); start + span <= ms("2026-11-20"); start += Math.round(182.5 * 86_400_000)) {
  const end = start + span;
  const b0 = closeAt(btc, start);
  const b1 = closeAt(btc, end);
  const kind = b0 != null && b1 != null && b1 > b0 ? "bull" : "bear";
  windows.push({ name: `y3.5-${new Date(start).toISOString().slice(0, 10)}`, start, end, kind });
}

const base = {
  enabled: true,
  score: "absolute" as const,
  momentumDays: 30,
  trendDays: 50,
  leaderWeight: 0.8,
  defense: "equal" as const,
  regime: "btc-stay" as const,
  regimeDays: 200,
};

const specs: Array<[string, IntelligentSpec | null]> = [
  ["plain", null],
  ["stay100", { ...base, regimeDays: 100 }],
  ["stay150", { ...base, regimeDays: 150 }],
  ["stay200", { ...base, regimeDays: 200 }],
  ["stay250", { ...base, regimeDays: 250 }],
  ["stay300", { ...base, regimeDays: 300 }],
  ["mix200", { ...base, regime: "btc-mix", regimeDays: 200 }],
  ["above200", { ...base, regime: "above-only", regimeDays: 200 }],
  ["vsbtc-stay200", { ...base, score: "vsbtc", regimeDays: 200 }],
  ["mom90-stay200", { ...base, momentumDays: 90, trendDays: 100, regimeDays: 200 }],
];

function run(start: number, end: number, spec: IntelligentSpec | null): SimSuccess | null {
  const result = simulate({
    assets: [
      { symbol: "BTC", weight: 1 },
      { symbol: "ETH", weight: 1 },
    ],
    series: { BTC: btc, ETH: eth },
    btc,
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
  return result.ok ? result : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const rows = [];
for (const [name, spec] of specs) {
  const started = Date.now();
  let n = 0;
  let both = 0;
  let bullN = 0;
  let bullBoth = 0;
  let bearN = 0;
  let bearBoth = 0;
  const excessHold: number[] = [];
  const excessPlain: number[] = [];
  const btcStack: number[] = [];
  const ethStack: number[] = [];
  const bearBtcStack: number[] = [];
  const bearEthStack: number[] = [];
  for (const window of windows) {
    const intel = run(window.start, window.end, spec);
    const plain = name === "plain" ? intel : run(window.start, window.end, null);
    if (!intel || !plain) continue;
    const b0 = closeAt(btc, window.start);
    const e0 = closeAt(eth, window.start);
    if (b0 == null || e0 == null || !(b0 > 0) || !(e0 > 0)) continue;
    const holdBtc = 5_000 / b0;
    const holdEth = 5_000 / e0;
    const btcRatio = (intel.summary.endingQty.BTC ?? 0) / holdBtc;
    const ethRatio = (intel.summary.endingQty.ETH ?? 0) / holdEth;
    n += 1;
    const winHold = intel.summary.finalEquity > intel.summary.holdFinal + 0.01;
    const winPlain = intel.summary.finalEquity > plain.summary.finalEquity + 0.01;
    if (winHold && winPlain) both += 1;
    excessHold.push(intel.summary.finalEquity - intel.summary.holdFinal);
    excessPlain.push(intel.summary.finalEquity - plain.summary.finalEquity);
    btcStack.push(btcRatio);
    ethStack.push(ethRatio);
    if (window.kind === "bull") {
      bullN += 1;
      if (winHold && winPlain) bullBoth += 1;
    } else {
      bearN += 1;
      if (winHold && winPlain) bearBoth += 1;
      bearBtcStack.push(btcRatio);
      bearEthStack.push(ethRatio);
    }
  }
  const row = {
    at: new Date().toISOString(),
    book: "btc-eth",
    version: `btc-eth/${name}`,
    n,
    windows: windows.length,
    bullN,
    bearN,
    bothRate: n ? both / n : 0,
    bullRate: bullN ? bullBoth / bullN : 0,
    bearRate: bearN ? bearBoth / bearN : 0,
    medianExcessHold: median(excessHold),
    medianExcessPlain: median(excessPlain),
    medianBtcStack: median(btcStack),
    medianEthStack: median(ethStack),
    bearMedianBtcStack: median(bearBtcStack),
    bearMedianEthStack: median(bearEthStack),
    seconds: (Date.now() - started) / 1000,
    spec,
  };
  rows.push(row);
  const pct = (v: number) => (100 * v).toFixed(1);
  console.log(
    `${name} both ${pct(row.bothRate)} bull ${pct(row.bullRate)} bear ${pct(row.bearRate)} ` +
      `medHold ${row.medianExcessHold?.toFixed(0)} medPlain ${row.medianExcessPlain?.toFixed(0)} ` +
      `btcStack ${row.medianBtcStack?.toFixed(3)} ethStack ${row.medianEthStack?.toFixed(3)} ` +
      `bearBtc ${row.bearMedianBtcStack?.toFixed(3)} bearEth ${row.bearMedianEthStack?.toFixed(3)} n ${n}`,
  );
}

writeFileSync("results/btc-eth-long.json", JSON.stringify({ windows: windows.length, rows }, null, 2));
console.log(`wrote ${rows.length} rows`);
