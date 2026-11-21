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

test("targets use only the selected coins and sum to 1", () => {
  const start = Date.UTC(2024, 0, 1);
  const up = Array.from({ length: 80 }, (_, i) => 100 + i);
  const flat = Array.from({ length: 80 }, () => 50);
  const aaa = series("AAA", start, up);
  const bbb = series("BBB", start, flat);
  const decision = start + 79 * DAY;
  const targets = intelligentTargets(
    [
      { symbol: "AAA", weight: 1 },
      { symbol: "BBB", weight: 1 },
    ],
    { AAA: aaa, BBB: bbb },
    null,
    decision,
    [up[up.length - 1], flat[flat.length - 1]],
    { ...DEFAULTS, defense: "btc", leaderWeight: 0.8 },
  );
  assert.notEqual(targets, "stay");
  if (targets === "stay") return;
  assert.deepEqual(targets.map((row) => row.symbol), ["AAA", "BBB"]);
  const sum = targets.reduce((total, row) => total + row.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(targets[0].weight > targets[1].weight);
  assert.ok(targets.every((row) => row.weight > 0));
});

test("USDT takes the book when every selected coin is in a downtrend", () => {
  const start = Date.UTC(2024, 0, 1);
  const down = Array.from({ length: 80 }, (_, i) => 100 - i);
  const decision = start + 79 * DAY;
  const targets = intelligentTargets(
    [
      { symbol: "AAA", weight: 1 },
      { symbol: "BBB", weight: 1 },
      { symbol: "USDT", weight: 1 },
    ],
    { AAA: series("AAA", start, down), BBB: series("BBB", start, down) },
    null,
    decision,
    [down[down.length - 1], down[down.length - 1], 1],
    DEFAULTS,
  );
  assert.notEqual(targets, "stay");
  if (targets === "stay") return;
  assert.deepEqual(targets.map((row) => row.symbol), ["AAA", "BBB", "USDT"]);
  assert.equal(targets[0].weight, 0);
  assert.equal(targets[1].weight, 0);
  assert.ok(Math.abs(targets[2].weight - 1) < 1e-9);
});

test("USDT absorbs only the coin that failed, and a book without USDT stays in its coins", () => {
  const start = Date.UTC(2024, 0, 1);
  const up = Array.from({ length: 80 }, (_, i) => 100 + i);
  const down = Array.from({ length: 80 }, (_, i) => 100 - i);
  const decision = start + 79 * DAY;
  const withCash = intelligentTargets(
    [
      { symbol: "AAA", weight: 1 },
      { symbol: "BBB", weight: 1 },
      { symbol: "USDT", weight: 1 },
    ],
    { AAA: series("AAA", start, up), BBB: series("BBB", start, down) },
    null,
    decision,
    [up[up.length - 1], down[down.length - 1], 1],
    DEFAULTS,
  );
  assert.notEqual(withCash, "stay");
  if (withCash === "stay") return;
  assert.equal(withCash[1].weight, 0);
  assert.ok(withCash[0].weight > 0);
  assert.ok(withCash[2].weight > withCash[0].weight);
  const sum = withCash.reduce((total, row) => total + row.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);

  const coinsOnly = intelligentTargets(
    [
      { symbol: "AAA", weight: 1 },
      { symbol: "BBB", weight: 1 },
    ],
    { AAA: series("AAA", start, down), BBB: series("BBB", start, down) },
    null,
    decision,
    [down[down.length - 1], down[down.length - 1]],
    { ...DEFAULTS, defense: "equal" },
  );
  assert.notEqual(coinsOnly, "stay");
  if (coinsOnly === "stay") return;
  assert.deepEqual(coinsOnly.map((row) => row.symbol), ["AAA", "BBB"]);
  assert.ok(coinsOnly.every((row) => row.weight > 0));
  const coinSum = coinsOnly.reduce((total, row) => total + row.weight, 0);
  assert.ok(Math.abs(coinSum - 1) < 1e-9);
});

test("bitcoin receives a failed book only when it was already selected", () => {
  const start = Date.UTC(2024, 0, 1);
  const down = Array.from({ length: 80 }, (_, i) => 80 - i * 0.2);
  const flat = Array.from({ length: 80 }, () => 40);
  const decision = start + 79 * DAY;
  const held = intelligentTargets(
    [
      { symbol: "AAA", weight: 1 },
      { symbol: "BTC", weight: 1 },
    ],
    {
      AAA: series("AAA", start, down),
      BTC: series("BTC", start, flat),
    },
    series("BTC", start, flat),
    decision,
    [down[down.length - 1], flat[flat.length - 1]],
    { ...DEFAULTS, defense: "equal" },
  );
  assert.notEqual(held, "stay");
  if (held === "stay") return;
  assert.deepEqual(held.map((row) => row.symbol), ["AAA", "BTC"]);
  assert.equal(held[0].weight, 0);
  assert.ok(Math.abs(held[1].weight - 1) < 1e-9);
});

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
