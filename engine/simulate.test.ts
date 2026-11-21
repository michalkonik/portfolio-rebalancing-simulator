import assert from "node:assert/strict";
import { test } from "node:test";
import { pairCorrelation, pearson } from "./correlation.ts";
import { parseCandleCsv } from "./csv.ts";
import { simulate } from "./simulate.ts";
import type { CandleSeries, SimInput, SimSuccess } from "./types.ts";

const DAY = 86_400_000;

function series(symbol: string, start: number, step: number, closes: number[]): CandleSeries {
  return {
    symbol,
    t: closes.map((_, i) => start + i * step),
    o: closes.slice(),
    c: closes.slice(),
  };
}

function run(partial: Partial<SimInput> & Pick<SimInput, "assets" | "series" | "startMs" | "endMs">): SimSuccess {
  const result = simulate({
    initialUsdt: 1000,
    feeBps: 0,
    slippageBps: 0,
    frequency: "weekly",
    band: 0,
    fraction: 1,
    trend: { enabled: false, smaDays: 30 },
    blockedBuyPolicy: "keep_winners",
    ...partial,
  });
  if (!result.ok) throw new Error(result.error);
  return result;
}

test("entry fee reduces a flat portfolio and hold does not trade", () => {
  const start = Date.UTC(2024, 0, 1);
  const result = run({
    initialUsdt: 1000,
    feeBps: 100,
    frequency: "none",
    startMs: start,
    endMs: start + 10 * DAY,
    assets: [
      { symbol: "AAA", weight: 50 },
      { symbol: "BBB", weight: 50 },
    ],
    series: {
      AAA: series("AAA", start, DAY, Array(11).fill(10)),
      BBB: series("BBB", start, DAY, Array(11).fill(20)),
    },
  });
  assert.ok(Math.abs(result.summary.finalEquity - 990) < 1e-6);
  assert.ok(Math.abs(result.summary.fees - 10) < 1e-6);
  assert.equal(result.summary.rebalances, 0);
  assert.ok(Math.abs(result.summary.endingQty.AAA - 49.5) < 1e-9);
  assert.ok(Math.abs(result.summary.endingQty.BBB - 24.75) < 1e-9);
});

test("full rebalance restores equal weights and the drag matches the hold gap", () => {
  const start = Date.UTC(2024, 0, 1);
  const times = [start, start + 7 * DAY, start + 7 * DAY + 4 * 60 * 60 * 1000];
  const result = run({
    startMs: start,
    endMs: times[2],
    assets: [
      { symbol: "AAA", weight: 1 },
      { symbol: "BBB", weight: 1 },
    ],
    series: {
      AAA: { symbol: "AAA", t: times, o: [100, 200, 300], c: [100, 200, 300] },
      BBB: { symbol: "BBB", t: times, o: [100, 100, 50], c: [100, 100, 50] },
    },
  });
  assert.equal(result.events.length, 1);
  const qtyA = result.points[1].qty[0];
  const qtyB = result.points[1].qty[1];
  assert.ok(Math.abs(qtyA - 3.75) < 1e-9, `qtyA ${qtyA}`);
  assert.ok(Math.abs(qtyB - 7.5) < 1e-9, `qtyB ${qtyB}`);
  assert.ok(Math.abs(result.points[1].weights[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(result.summary.dragUsdt - 250) < 1e-6);
  assert.ok(Math.abs(result.summary.holdFinal - result.summary.finalEquity - 250) < 1e-6);
  assert.equal(result.summary.trapEvents, 0);
});

test("a 30 day trail flags selling the winner into the laggard", () => {
  const start = Date.UTC(2024, 0, 1);
  const days = 40;
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < days; i++) {
    a.push(100 * (1 + i / 100));
    b.push(100 * (1 - i / 200));
  }
  const result = run({
    frequency: "monthly",
    startMs: start,
    endMs: start + (days - 1) * DAY,
    assets: [
      { symbol: "AAA", weight: 50 },
      { symbol: "BBB", weight: 50 },
    ],
    series: {
      AAA: series("AAA", start - 0, DAY, a),
      BBB: series("BBB", start, DAY, b),
    },
  });
  assert.ok(result.summary.trapEvents > 0);
  assert.ok(result.summary.dragUsdt > 0);
});

test("sell lock never reduces the locked coin", () => {
  const start = Date.UTC(2024, 0, 1);
  const result = run({
    frequency: "daily",
    startMs: start,
    endMs: start + 2 * DAY,
    assets: [
      { symbol: "AAA", weight: 50, sellLocked: true },
      { symbol: "BBB", weight: 50 },
    ],
    series: {
      AAA: series("AAA", start, DAY, [100, 200, 300]),
      BBB: series("BBB", start, DAY, [100, 100, 50]),
    },
  });
  assert.ok(result.points.every((point) => Math.abs(point.qty[0] - 5) < 1e-9));
  assert.equal(result.events.length, 0);
});

test("trend filter with keep-winners does not sell the winner into a falling coin", () => {
  const start = Date.UTC(2024, 0, 10);
  const aCloses = [100, 100, 100, 100, 200, 300];
  const bCloses = [120, 100, 80, 70, 60, 50];
  const origin = start - 3 * DAY;
  const result = run({
    frequency: "daily",
    startMs: start,
    endMs: origin + (bCloses.length - 1) * DAY,
    trend: { enabled: true, smaDays: 2 },
    blockedBuyPolicy: "keep_winners",
    assets: [
      { symbol: "AAA", weight: 50 },
      { symbol: "BBB", weight: 50 },
    ],
    series: {
      AAA: series("AAA", origin, DAY, aCloses),
      BBB: series("BBB", origin, DAY, bCloses),
    },
  });
  const entry = 500 / 100;
  assert.ok(result.points.every((point) => Math.abs(point.qty[0] - entry) < 1e-9));
  assert.equal(result.events.length, 0);
});

test("park policy sells the winner and holds USDT when the buy is blocked", () => {
  const start = Date.UTC(2024, 0, 10);
  const origin = start - 3 * DAY;
  const result = run({
    frequency: "daily",
    startMs: start,
    endMs: origin + 5 * DAY,
    trend: { enabled: true, smaDays: 2 },
    blockedBuyPolicy: "park_usdt",
    fraction: 1,
    assets: [
      { symbol: "AAA", weight: 50 },
      { symbol: "BBB", weight: 50 },
    ],
    series: {
      AAA: series("AAA", origin, DAY, [100, 100, 100, 100, 200, 300]),
      BBB: series("BBB", origin, DAY, [120, 100, 80, 70, 60, 50]),
    },
  });
  assert.ok(result.events.length > 0);
  assert.ok(result.events.every((event) => event.trades.every((trade) => trade.symbol !== "BBB" || trade.side !== "buy")));
  assert.ok(result.summary.endingUsdt > 1);
  assert.ok(result.summary.endingQty.AAA < 5);
});

test("drift band skips a small move and a partial rebalance closes half the gap", () => {
  const start = Date.UTC(2024, 0, 1);
  const blocked = run({
    frequency: "daily",
    startMs: start,
    endMs: start + DAY,
    band: 0.25,
    assets: [
      { symbol: "AAA", weight: 50 },
      { symbol: "BBB", weight: 50 },
    ],
    series: {
      AAA: series("AAA", start, DAY, [100, 200]),
      BBB: series("BBB", start, DAY, [100, 100]),
    },
  });
  // Gap is about 16.7pp, under a 25pp band.
  assert.equal(blocked.events.length, 0);

  const half = run({
    frequency: "daily",
    startMs: start,
    endMs: start + 2 * DAY,
    fraction: 0.5,
    assets: [
      { symbol: "AAA", weight: 50 },
      { symbol: "BBB", weight: 50 },
    ],
    series: {
      AAA: series("AAA", start, DAY, [100, 200, 200]),
      BBB: series("BBB", start, DAY, [100, 100, 100]),
    },
  });
  assert.ok(Math.abs(half.points[1].qty[0] - 4.375) < 1e-9);
  assert.ok(Math.abs(half.points[1].qty[1] - 6.25) < 1e-9);
});

test("weights that do not sum to 100 are normalized", () => {
  const start = Date.UTC(2024, 0, 1);
  const result = run({
    frequency: "none",
    startMs: start,
    endMs: start + DAY,
    assets: [
      { symbol: "AAA", weight: 33 },
      { symbol: "BBB", weight: 33 },
      { symbol: "CCC", weight: 33 },
    ],
    series: {
      AAA: series("AAA", start, DAY, [10, 10]),
      BBB: series("BBB", start, DAY, [10, 10]),
      CCC: series("CCC", start, DAY, [10, 10]),
    },
  });
  assert.ok(Math.abs(result.assets[0].weight - 1 / 3) < 1e-12);
  assert.equal(result.summary.endingQty.AAA, result.summary.endingQty.CCC);
});

test("one coin is allowed and a reversed date range is not", () => {
  const start = Date.UTC(2024, 0, 1);
  const one = simulate({
    assets: [{ symbol: "AAA", weight: 1 }],
    series: { AAA: series("AAA", start, DAY, [1, 2]) },
    startMs: start,
    endMs: start + DAY,
    initialUsdt: 100,
    feeBps: 0,
    slippageBps: 0,
    frequency: "none",
    band: 0,
    fraction: 1,
    trend: { enabled: false, smaDays: 10 },
    blockedBuyPolicy: "keep_winners",
  });
  assert.equal(one.ok, true);
  if (one.ok) assert.ok(Math.abs(one.summary.finalEquity - 200) < 1e-9);
  const tooMany = simulate({
    assets: Array.from({ length: 11 }, (_, i) => ({ symbol: `C${i}`, weight: 1 })),
    series: {},
    startMs: start,
    endMs: start + DAY,
    initialUsdt: 100,
    feeBps: 0,
    slippageBps: 0,
    frequency: "none",
    band: 0,
    fraction: 1,
    trend: { enabled: false, smaDays: 10 },
    blockedBuyPolicy: "keep_winners",
  });
  assert.equal(tooMany.ok, false);
  const dates = simulate({
    assets: [
      { symbol: "AAA", weight: 1 },
      { symbol: "BBB", weight: 1 },
    ],
    series: {
      AAA: series("AAA", start, DAY, [1, 1]),
      BBB: series("BBB", start, DAY, [1, 1]),
    },
    startMs: start + DAY,
    endMs: start,
    initialUsdt: 100,
    feeBps: 0,
    slippageBps: 0,
    frequency: "none",
    band: 0,
    fraction: 1,
    trend: { enabled: false, smaDays: 10 },
    blockedBuyPolicy: "keep_winners",
  });
  assert.equal(dates.ok, false);
});

test("correlation is 1, -1, and splits with the BTC day", () => {
  assert.equal(pearson([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]), 1);
  assert.ok(Math.abs((pearson([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]) ?? 0) + 1) < 1e-12);
  const start = Date.UTC(2024, 0, 1);
  const btc = [100];
  const left = [100];
  const right = [100];
  for (let i = 1; i < 40; i++) {
    const up = i % 2 === 0;
    const mag = 1 + (i % 5) * 0.2;
    btc.push(btc[i - 1] * (up ? 1 + 0.01 * mag : 1 - 0.01 * mag));
    left.push(left[i - 1] * (up ? 1 + 0.02 * mag : 1 - 0.03 * mag));
    // Rises with BTC on up days, and rises while BTC falls on down days.
    right.push(right[i - 1] * (up ? 1 + 0.005 * mag : 1 + 0.02 * mag));
  }
  const pair = pairCorrelation(
    series("L", start, DAY, left),
    series("R", start, DAY, right),
    series("BTC", start, DAY, btc),
    start,
    start + 39 * DAY,
  );
  assert.ok((pair.all ?? 0) < 0.5);
  assert.ok((pair.btcUp ?? 1) > 0);
  assert.ok((pair.btcDown ?? 0) < 0);
  assert.ok(pair.observations >= 30);
});

test("csv parser keeps ascending positive closes", () => {
  const parsed = parseCandleCsv("t,o,h,l,c,v\n10,1,1,1,2,9\n10,1,1,1,3,9\n20,2,2,2,4,1\nbad\n", "BTC");
  assert.deepEqual(parsed.t, [10, 20]);
  assert.deepEqual(parsed.c, [2, 4]);
});

test("every bar carries each coin's USDT value and the BTC price", () => {
  const start = Date.UTC(2024, 0, 1);
  const result = run({
    frequency: "none",
    startMs: start,
    endMs: start + 2 * DAY,
    assets: [{ symbol: "AAA", weight: 1 }],
    series: {
      AAA: series("AAA", start, DAY, [5, 10, 20]),
    },
    btc: series("BTC", start, DAY, [100, 110, 140]),
  });
  assert.deepEqual(result.points.map((point) => point.btcPrice), [100, 110, 140]);
  assert.ok(Math.abs(result.points[0].values[0] - 1000) < 1e-6);
  assert.ok(Math.abs(result.points[2].values[0] - 4000) < 1e-6);
  assert.ok(Math.abs(result.points[2].values[0] - result.points[2].qty[0] * 20) < 1e-6);
  assert.ok(Math.abs((result.points[2].btc ?? 0) / (result.points[0].btc ?? 1) - 1.4) < 1e-9);
});
