import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseCandleCsv } from "../engine/csv.ts";
import { simulate } from "../engine/simulate.ts";
import type { CandleSeries, IntelligentSpec } from "../engine/types.ts";

const books = [
  ["BTC", "ETH"],
  ["BTC", "ETH", "USDT"],
  ["USDT", "SOL", "SUI"],
  ["SOL", "SUI"],
  ["PEPE", "WIF", "DOGE"],
  ["INJ", "GRAM", "BTC"],
  ["BTC", "ZEC"],
  ["BTC", "UNI"],
  ["PENDLE", "TAO", "ZEC"],
  ["SUI", "SOL", "HBAR"],
  ["LINK", "DOT", "ATOM"],
  ["XRP", "ADA", "DOGE"],
  ["LTC", "BCH", "ETC"],
  ["AAVE", "UNI", "LINK"],
  ["ETH", "SOL", "AVAX"],
  ["BTC", "SOL", "DOGE"],
  ["BTC", "BNB", "ETH"],
  ["XRP", "LTC", "BTC"],
  ["ADA", "DOT", "LINK"],
  ["DOGE", "SHIB"],
  ["BCH", "LTC"],
  ["ETC", "BCH"],
  ["FIL", "DOT"],
  ["SAND", "MANA"],
  ["AXS", "GALA"],
  ["CRV", "COMP"],
  ["ATOM", "AVAX", "NEAR"],
];

const windows: Array<[string, number, number, "bear" | "bull" | "mixed"]> = [
  ["bear-2022", Date.UTC(2022, 0, 1), Date.UTC(2022, 11, 31, 23, 59, 59), "bear"],
  ["year-2023", Date.UTC(2023, 0, 1), Date.UTC(2023, 11, 31, 23, 59, 59), "mixed"],
  ["bull-2024", Date.UTC(2024, 0, 1), Date.UTC(2024, 11, 31, 23, 59, 59), "bull"],
  ["from-2025", Date.UTC(2025, 0, 20), Date.UTC(2026, 10, 20, 23, 59, 59), "bear"],
  ["from-2023", Date.UTC(2023, 0, 1), Date.UTC(2026, 10, 20, 23, 59, 59), "mixed"],
  ["from-2024", Date.UTC(2024, 0, 20), Date.UTC(2026, 10, 20, 23, 59, 59), "mixed"],
];

const cache = new Map<string, CandleSeries>();
function load(symbol: string): CandleSeries {
  const got = cache.get(symbol);
  if (got) return got;
  const raw = gunzipSync(readFileSync(`docs/data/candles/${symbol}.csv.gz`));
  const parsed = parseCandleCsv(raw.toString("utf8"), symbol);
  cache.set(symbol, parsed);
  return parsed;
}

function listedAtStart(symbols: string[], startMs: number): boolean {
  for (const symbol of symbols) {
    if (symbol === "USDT") continue;
    const first = load(symbol).t[0];
    if (first == null || first > startMs + 14 * 86_400_000) return false;
  }
  return true;
}

function run(symbols: string[], startMs: number, endMs: number, spec: IntelligentSpec): number | null {
  if (!listedAtStart(symbols, startMs)) return null;
  const series: Record<string, CandleSeries> = {};
  for (const symbol of new Set([...symbols, "BTC"])) {
    if (symbol === "USDT") continue;
    series[symbol] = load(symbol);
  }
  const result = simulate({
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
    intelligent: spec,
  });
  if (!result.ok) return null;
  if (!(result.summary.holdFinal > 0)) return null;
  return result.summary.finalEquity / result.summary.holdFinal;
}

const base: IntelligentSpec = {
  enabled: true,
  score: "absolute",
  momentumDays: 30,
  trendDays: 50,
  leaderWeight: 0.8,
  defense: "equal",
};

const rules: Array<[string, IntelligentSpec]> = [
  ["leader", base],
  ["down-mix", { ...base, regime: "down-mix" }],
  ["down-stay", { ...base, regime: "down-stay" }],
  ["alldown-mix", { ...base, regime: "alldown-mix" }],
  ["alldown-stay", { ...base, regime: "alldown-stay" }],
  ["btc50-mix", { ...base, regime: "btc-mix", regimeDays: 50 }],
  ["btc100-mix", { ...base, regime: "btc-mix", regimeDays: 100 }],
  ["btc200-mix", { ...base, regime: "btc-mix", regimeDays: 200 }],
  ["btc150-stay", { ...base, regime: "btc-stay", regimeDays: 150 }],
  ["btc200-stay", { ...base, regime: "btc-stay", regimeDays: 200 }],
  ["btc250-stay", { ...base, regime: "btc-stay", regimeDays: 250 }],
  ["above-only", { ...base, regime: "above-only" }],
  ["above-only-200", { ...base, regime: "above-only", regimeDays: 200 }],
];

const focus = new Set(["BTC/ETH/USDT", "USDT/SOL/SUI", "SOL/SUI", "PEPE/WIF/DOGE", "INJ/GRAM/BTC"]);

for (const [name, spec] of rules) {
  let wins = 0;
  let ties = 0;
  let losses = 0;
  let bearLoss = 0;
  let bullLoss = 0;
  let worst = Infinity;
  let worstLabel = "";
  const focusRows: string[] = [];
  for (const symbols of books) {
    for (const [label, start, end, kind] of windows) {
      const ratio = run(symbols, start, end, spec);
      const id = `${symbols.join("/")} ${label}`;
      if (ratio == null) continue;
      if (ratio < worst) {
        worst = ratio;
        worstLabel = `${id} ${ratio.toFixed(3)}`;
      }
      if (ratio > 1.001) wins += 1;
      else if (ratio >= 0.999) ties += 1;
      else {
        losses += 1;
        if (kind === "bear") bearLoss += 1;
        if (kind === "bull") bullLoss += 1;
      }
      if (focus.has(symbols.join("/")) && label === "from-2025") {
        focusRows.push(`${id} ${ratio.toFixed(3)}`);
      }
    }
  }
  const tested = wins + ties + losses;
  console.log(
    `${name}: tested ${tested} wins ${wins} ties ${ties} losses ${losses} bearLoss ${bearLoss} bullLoss ${bullLoss} worst ${worst.toFixed(3)} ${worstLabel}`,
  );
  for (const row of focusRows) console.log(`  ${row}`);
}

