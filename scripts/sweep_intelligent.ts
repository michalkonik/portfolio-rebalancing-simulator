import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseCandleCsv } from "../engine/csv.ts";
import { simulate } from "../engine/simulate.ts";
import type { CandleSeries, IntelligentDefense, IntelligentSpec } from "../engine/types.ts";

const endMs = Date.UTC(2026, 10, 20, 23, 59, 59);
const startMs = Date.UTC(2023, 0, 1);

function load(symbol: string): CandleSeries {
  const raw = gunzipSync(readFileSync(`docs/data/candles/${symbol}.csv.gz`));
  return parseCandleCsv(raw.toString("utf8"), symbol);
}

const books = [
  ["BTC", "ETH"],
  ["BTC", "ZEC"],
  ["BTC", "UNI"],
  ["TAO", "NEAR"],
  ["SUI", "PENDLE", "UNI"],
];

const cache = new Map<string, CandleSeries>();
function seriesFor(symbols: string[]): Record<string, CandleSeries> {
  const out: Record<string, CandleSeries> = {};
  for (const symbol of new Set([...symbols, "BTC"])) {
    const got = cache.get(symbol) ?? load(symbol);
    cache.set(symbol, got);
    out[symbol] = got;
  }
  return out;
}

function runBook(
  symbols: string[],
  spec: IntelligentSpec | null,
  everyDays: number,
): { final: number; hold: number; start: string } | string {
  const series = seriesFor(symbols);
  const result = simulate({
    assets: symbols.map((symbol) => ({ symbol, weight: 1 })),
    series,
    btc: series.BTC,
    startMs,
    endMs,
    initialUsdt: 10_000,
    feeBps: 10,
    slippageBps: 5,
    frequency: spec ? "custom" : "none",
    everyDays,
    band: 0,
    fraction: 1,
    trend: { enabled: false, smaDays: 30 },
    blockedBuyPolicy: "keep_winners",
    intelligent: spec ?? undefined,
  });
  if (!result.ok) return result.error;
  return {
    final: result.summary.finalEquity,
    hold: result.summary.holdFinal,
    start: new Date(result.startMs).toISOString().slice(0, 10),
  };
}

const holds = new Map<string, { hold: number; start: string }>();
for (const symbols of books) {
  const name = symbols.join("/");
  const held = runBook(symbols, null, 30);
  if (typeof held === "string") {
    console.log("HOLD FAIL", name, held);
    continue;
  }
  holds.set(name, { hold: held.hold, start: held.start });
  console.log(`HOLD ${name} from ${held.start} ${held.hold.toFixed(0)}`);
}

const grid: IntelligentSpec[] = [];
for (const score of ["vsbtc", "absolute"] as const) {
  for (const momentumDays of [30, 60, 90, 140]) {
    for (const trendDays of [50, 100, 140, 200]) {
      for (const leaderWeight of [0.8, 1]) {
        for (const defense of ["stay", "equal", "btc"] as IntelligentDefense[]) {
          grid.push({ enabled: true, score, momentumDays, trendDays, leaderWeight, defense });
        }
      }
    }
  }
}

let best: { spec: IntelligentSpec; everyDays: number; worst: number; ratios: number[] } | null = null;
const winners: Array<{ spec: IntelligentSpec; everyDays: number; ratios: number[] }> = [];
let tried = 0;
for (const everyDays of [14, 30, 60, 90]) {
  for (const spec of grid) {
    const ratios: number[] = [];
    let ok = true;
    for (const symbols of books) {
      const name = symbols.join("/");
      const ran = runBook(symbols, spec, everyDays);
      const hold = holds.get(name);
      if (typeof ran === "string" || !hold || !(hold.hold > 0)) {
        ok = false;
        break;
      }
      ratios.push(ran.final / hold.hold);
    }
    if (!ok) continue;
    tried += 1;
    const worst = Math.min(...ratios);
    if (!best || worst > best.worst) best = { spec, everyDays, worst, ratios };
    if (ratios.every((ratio) => ratio >= 1.2)) winners.push({ spec, everyDays, ratios });
  }
}

console.log(`tried ${tried} winners ${winners.length}`);
if (best) {
  console.log("BEST", JSON.stringify(best.spec), "every", best.everyDays, "worst", best.worst.toFixed(3), "ratios", best.ratios.map((r) => r.toFixed(3)).join(" "));
}
for (const winner of winners.slice(0, 12)) {
  console.log("WIN", winner.everyDays, JSON.stringify(winner.spec), winner.ratios.map((r) => r.toFixed(3)).join(" "));
}
