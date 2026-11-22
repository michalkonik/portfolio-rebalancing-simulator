import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseCandleCsv } from "../engine/csv.ts";
import { simulate } from "../engine/simulate.ts";
import type { CandleSeries, IntelligentSpec } from "../engine/types.ts";

interface FileShape {
  groups: Array<{ id: string; title: string; portfolios: string[][] }>;
}

const file = JSON.parse(readFileSync("/home/mkoniu/Desktop/rebalance-portfolios.json", "utf8")) as FileShape;
const windows: Array<[string, number, number]> = [
  ["2023-now", Date.UTC(2023, 0, 1), Date.UTC(2026, 10, 20, 23, 59, 59)],
  ["2024-now", Date.UTC(2024, 0, 1), Date.UTC(2026, 10, 20, 23, 59, 59)],
  ["2025-now", Date.UTC(2025, 0, 1), Date.UTC(2026, 10, 20, 23, 59, 59)],
  ["2026-now", Date.UTC(2026, 0, 1), Date.UTC(2026, 10, 20, 23, 59, 59)],
  ["2023-2024", Date.UTC(2023, 0, 1), Date.UTC(2024, 0, 1)],
  ["2024-2025-07", Date.UTC(2024, 0, 1), Date.UTC(2025, 6, 31, 23, 59, 59)],
];

const cache = new Map<string, CandleSeries>();
function load(symbol: string): CandleSeries | null {
  if (symbol === "USDT") return null;
  const got = cache.get(symbol);
  if (got) return got;
  const raw = gunzipSync(readFileSync(`docs/data/candles/${symbol}.csv.gz`));
  const parsed = parseCandleCsv(raw.toString("utf8"), symbol);
  cache.set(symbol, parsed);
  return parsed;
}

const base = {
  enabled: true,
  score: "absolute" as const,
  momentumDays: 30,
  trendDays: 50,
  leaderWeight: 0.8,
  defense: "equal" as const,
};

const specs: Array<[string, IntelligentSpec]> = [
  ["gate200", { ...base, regime: "btc-stay", regimeDays: 200 }],
  ["leader", { ...base }],
  ["above100", { ...base, regime: "above-only", regimeDays: 100 }],
  ["down-stay", { ...base, regime: "down-stay" }],
  ["btc-mix100", { ...base, regime: "btc-mix", regimeDays: 100 }],
  ["leader-full", { ...base, leaderWeight: 1, momentumDays: 90, trendDays: 100, regime: "btc-stay", regimeDays: 200 }],
];

const groupFilter = process.argv[2];
const groups = file.groups.filter((group) => !groupFilter || group.id === groupFilter);

function run(symbols: string[], startMs: number, endMs: number, spec: IntelligentSpec | null) {
  const series: Record<string, CandleSeries> = {};
  for (const symbol of new Set([...symbols, "BTC"])) {
    const candle = load(symbol);
    if (candle) series[symbol] = candle;
  }
  return simulate({
    assets: symbols.map((symbol) => ({ symbol, weight: 1 })),
    series,
    btc: series.BTC,
    startMs,
    endMs,
    initialUsdt: 10_000,
    feeBps: 10,
    slippageBps: 5,
    frequency: "custom",
    everyDays: 14,
    band: 0,
    fraction: 1,
    trend: { enabled: false, smaDays: 50 },
    blockedBuyPolicy: "keep_winners",
    intelligent: spec ?? undefined,
  });
}

for (const [name, spec] of specs) {
  const started = Date.now();
  for (const group of groups) {
    let eligible = 0;
    let pass = 0;
    let ineligible = 0;
    for (const symbols of group.portfolios) {
      for (const [, start, end] of windows) {
        const intel = run(symbols, start, end, spec);
        const plain = run(symbols, start, end, null);
        if (!intel.ok || !plain.ok) {
          ineligible += 1;
          continue;
        }
        eligible += 1;
        const aheadHold = intel.summary.finalEquity > intel.summary.holdFinal + 0.01;
        const aheadPlain = intel.summary.finalEquity > plain.summary.finalEquity + 0.01;
        if (aheadHold && aheadPlain) pass += 1;
      }
    }
    const rate = eligible ? (100 * pass) / eligible : 0;
    console.log(`${name} ${group.id}: pass ${pass}/${eligible} (${rate.toFixed(1)}%) skip ${ineligible}`);
  }
  console.log(`${name} done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
