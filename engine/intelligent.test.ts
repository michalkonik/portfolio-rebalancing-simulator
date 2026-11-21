import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { parseCandleCsv } from "./csv.ts";
import { intelligentTargets } from "./intelligent.ts";
import { simulate } from "./simulate.ts";
import type { CandleSeries, IntelligentSpec, SimSuccess } from "./types.ts";

const DAY = 86_400_000;

const DEFAULTS: IntelligentSpec = {
  enabled: true,
  score: "absolute",
  momentumDays: 30,
  trendDays: 50,
  leaderWeight: 0.8,
  defense: "btc",
};

function series(symbol: string, start: number, closes: number[]): CandleSeries {
  return {
    symbol,
    t: closes.map((_, i) => start + i * DAY),
    o: closes.slice(),
    c: closes.slice(),
  };
}

test("the trend average ignores closes after the decision", () => {
  const start = Date.UTC(2024, 0, 1);
  const past = Array.from({ length: 40 }, () => 10);
  const future = Array.from({ length: 40 }, () => 1000);
  const aaa = series("AAA", start, [...past, 12, ...future]);
  const bbb = series("BBB", start, Array.from({ length: aaa.c.length }, () => 10));
  const decision = start + 40 * DAY;
  const targets = intelligentTargets(
    [
      { symbol: "AAA", weight: 1 },
      { symbol: "BBB", weight: 1 },
    ],
    { AAA: aaa, BBB: bbb },
    null,
    decision,
    [12, 10],
    { ...DEFAULTS, trendDays: 20, momentumDays: 20, leaderWeight: 1 },
  );
  assert.notEqual(targets, "stay");
  if (targets === "stay") return;
  assert.equal(targets[0]?.weight, 1);
  assert.equal(targets[1]?.weight, 0);
});

test("the researched defaults beat hold by at least 20 percent on the five books", () => {
  const books = [
    ["BTC", "ETH"],
    ["BTC", "ZEC"],
    ["BTC", "UNI"],
    ["TAO", "NEAR"],
    ["SUI", "PENDLE", "UNI"],
  ];
  const cache = new Map<string, CandleSeries>();
  const load = (symbol: string): CandleSeries => {
    const got = cache.get(symbol);
    if (got) return got;
    const raw = gunzipSync(readFileSync(`docs/data/candles/${symbol}.csv.gz`));
    const parsed = parseCandleCsv(raw.toString("utf8"), symbol);
    cache.set(symbol, parsed);
    return parsed;
  };
  for (const symbols of books) {
    const seriesMap: Record<string, CandleSeries> = {};
    for (const symbol of new Set([...symbols, "BTC"])) seriesMap[symbol] = load(symbol);
    const result = simulate({
      assets: symbols.map((symbol) => ({ symbol, weight: 1 })),
      series: seriesMap,
      btc: seriesMap.BTC,
      startMs: Date.UTC(2023, 0, 1),
      endMs: Date.UTC(2026, 10, 20, 23, 59, 59),
      initialUsdt: 10_000,
      feeBps: 10,
      slippageBps: 5,
      frequency: "custom",
      everyDays: 14,
      band: 0,
      fraction: 1,
      trend: { enabled: false, smaDays: 50 },
      blockedBuyPolicy: "keep_winners",
      intelligent: DEFAULTS,
    });
    assert.equal(result.ok, true, symbols.join("/"));
    if (!result.ok) continue;
    const done = result as SimSuccess;
    const ratio = done.summary.finalEquity / done.summary.holdFinal;
    assert.ok(ratio >= 1.2, `${symbols.join("/")} ${ratio.toFixed(3)} is under 1.2`);
  }
});
