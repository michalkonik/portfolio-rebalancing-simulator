import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseCandleCsv } from "../engine/csv.ts";
import { simulate } from "../engine/simulate.ts";
import type { CandleSeries, IntelligentSpec, SimSuccess } from "../engine/types.ts";

const cache = new Map<string, CandleSeries>();
function load(symbol: string): CandleSeries {
  const got = cache.get(symbol);
  if (got) return got;
  const parsed = parseCandleCsv(
    gunzipSync(readFileSync(`docs/data/candles/${symbol}.csv.gz`)).toString("utf8"),
    symbol,
  );
  cache.set(symbol, parsed);
  return parsed;
}

const btc = load("BTC");
const eth = load("ETH");
const btcd = load("BTCD");
const total = load("TOTAL");

const common = {
  enabled: true,
  score: "absolute" as const,
  momentumDays: 30,
  trendDays: 50,
  leaderWeight: 0.8,
  defense: "equal" as const,
};

function runPair(start: number, end: number, spec: IntelligentSpec | null): SimSuccess | null {
  const result = simulate({
    assets: [
      { symbol: "BTC", weight: 1 },
      { symbol: "ETH", weight: 1 },
    ],
    series: { BTC: btc, ETH: eth, BTCD: btcd, TOTAL: total },
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

const named: Array<[string, string, string, "bull" | "bear"]> = [
  ["2017-bull", "2017-08-17", "2017-12-16", "bull"],
  ["2018-bear", "2017-12-17", "2018-12-15", "bear"],
  ["2019", "2019-01-01", "2020-03-12", "bear"],
  ["2020-bull", "2020-03-13", "2021-11-08", "bull"],
  ["2022-bear", "2021-11-09", "2022-11-21", "bear"],
  ["2023-24", "2023-01-01", "2024-03-13", "bull"],
  ["2024-26", "2024-03-14", "2026-11-20", "bull"],
  ["full", "2017-08-17", "2026-11-20", "bull"],
];

function day(iso: string, end = false): number {
  return Date.parse(`${iso}T${end ? "23:59:59" : "00:00:00"}Z`);
}

const pairSpecs: Array<[string, IntelligentSpec]> = [];
for (const floor of [0.1, 0.2, 0.3, 0.4]) {
  pairSpecs.push([
    `stay300-floor${Math.round(floor * 100)}`,
    { ...common, regime: "btc-stay", regimeDays: 300, floorWeight: floor },
  ]);
}
for (const floor of [0.1, 0.2, 0.3, 0.4]) {
  for (const pairMaDays of [90, 140, 200]) {
    for (const dominanceTrendDays of [60, 90, 180]) {
      pairSpecs.push([
        `band-f${Math.round(floor * 100)}-p${pairMaDays}-d${dominanceTrendDays}`,
        {
          ...common,
          regime: "cowen-band",
          bandWeeks: 20,
          bandEmaWeeks: 21,
          dominanceTrendDays,
          pairMaDays,
          floorWeight: floor,
        },
      ]);
    }
  }
}
pairSpecs.push(
  ["stay200", { ...common, regime: "btc-stay", regimeDays: 200 }],
  ["stay300", { ...common, regime: "btc-stay", regimeDays: 300 }],
  ["cowen-band", { ...common, regime: "cowen-band", bandWeeks: 20, bandEmaWeeks: 21, dominanceTrendDays: 90, pairMaDays: 140, floorWeight: 0 }],
  ["cowen-band-floor20", { ...common, regime: "cowen-band", bandWeeks: 20, bandEmaWeeks: 21, dominanceTrendDays: 90, pairMaDays: 140, floorWeight: 0.2 }],
);

const pairRows = [];
for (const [id, spec] of pairSpecs) {
  const byWindow: Record<string, { equity: number; hold: number; plain: number; btc: number; eth: number }> = {};
  let beatsHold = 0;
  let scored = 0;
  for (const [name, a, b] of named) {
    const intel = runPair(day(a), day(b, true), spec);
    const plain = runPair(day(a), day(b, true), null);
    if (!intel || !plain) continue;
    scored += 1;
    if (intel.summary.finalEquity > intel.summary.holdFinal + 0.01) beatsHold += 1;
    byWindow[name] = {
      equity: Math.round(intel.summary.finalEquity),
      hold: Math.round(intel.summary.holdFinal),
      plain: Math.round(plain.summary.finalEquity),
      btc: intel.summary.endingQty.BTC ?? 0,
      eth: intel.summary.endingQty.ETH ?? 0,
    };
  }
  const full = byWindow.full;
  pairRows.push({
    id,
    beatsHold,
    scored,
    keepsBothOnFull: full != null && full.btc > 0 && full.eth > 0,
    full,
    byWindow,
    spec,
  });
  console.log(id, "hold-wins", beatsHold, "/", scored, "full", full?.equity, "btc", full?.btc.toFixed(3), "eth", full?.eth.toFixed(3));
}

const file = JSON.parse(readFileSync("/home/mkoniu/Desktop/rebalance-portfolios.json", "utf8")) as {
  groups: Array<{ id: string; portfolios: string[][] }>;
};
const bookGroups: Record<string, string[]> = {
  "btc-alts": ["btc-one-alt", "btc-two-alts"],
  "alts-stable": ["usdt-one-alt", "usdt-two-alts"],
  alts: ["two-altcoins", "three-altcoins"],
};
const bookWindows: Array<[string, number, number, "bull" | "bear" | "full"]> = [
  ["2022-bear", Date.UTC(2021, 10, 9), Date.UTC(2022, 10, 21, 23, 59, 59), "bear"],
  ["2023-24", Date.UTC(2023, 0, 1), Date.UTC(2024, 2, 13, 23, 59, 59), "bull"],
  ["2024-26", Date.UTC(2024, 2, 14), Date.UTC(2026, 10, 20, 23, 59, 59), "bull"],
  ["from-2021-11", Date.UTC(2021, 10, 20), Date.UTC(2026, 10, 20, 23, 59, 59), "full"],
];
const cash = {
  ...common,
  regime: "cowen" as const,
  riskOff: "cash" as const,
  btcMaDays: 200,
  dominanceMaDays: 50,
  totalMaDays: 50,
};
const bookSpecs: Record<string, Array<[string, IntelligentSpec]>> = {
  "btc-alts": [
    ["stay200", { ...common, regime: "btc-stay", regimeDays: 200 }],
    ["stay300", { ...common, regime: "btc-stay", regimeDays: 300 }],
    ["stay300-floor20", { ...common, regime: "btc-stay", regimeDays: 300, floorWeight: 0.2 }],
  ],
  "alts-stable": [
    ["stay200", { ...common, regime: "btc-stay", regimeDays: 200 }],
    ["above-only", { ...common, regime: "above-only", regimeDays: 50 }],
    ["stay300", { ...common, regime: "btc-stay", regimeDays: 300 }],
  ],
  alts: [
    ["cash-200-50-50", cash],
    ["stay-200-50-50", { ...cash, riskOff: "stay" }],
    ["mix-200-50-50", { ...cash, riskOff: "mix" }],
  ],
};

function runBook(symbols: string[], start: number, end: number, spec: IntelligentSpec | null): SimSuccess | null {
  const series: Record<string, CandleSeries> = { BTC: btc, BTCD: btcd, TOTAL: total };
  for (const symbol of symbols) {
    if (symbol === "USDT") continue;
    series[symbol] = load(symbol);
  }
  const result = simulate({
    assets: symbols.map((symbol) => ({ symbol, weight: 1 })),
    series,
    btc,
    startMs: start,
    endMs: end,
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
  return result.ok ? result : null;
}

const bookRows = [];
for (const [book, groupIds] of Object.entries(bookGroups)) {
  const portfolios = file.groups.filter((group) => groupIds.includes(group.id)).flatMap((group) => group.portfolios);
  for (const [id, spec] of bookSpecs[book]) {
    let n = 0;
    let skipped = 0;
    let both = 0;
    let bullN = 0;
    let bullBoth = 0;
    let bearN = 0;
    let bearBoth = 0;
    const excess: number[] = [];
    const started = Date.now();
    for (const symbols of portfolios) {
      for (const [name, start, end, kind] of bookWindows) {
        const intel = runBook(symbols, start, end, spec);
        const plain = runBook(symbols, start, end, null);
        if (!intel || !plain) {
          skipped += 1;
          continue;
        }
        n += 1;
        const aheadHold = intel.summary.finalEquity > intel.summary.holdFinal + 0.01;
        const aheadPlain = intel.summary.finalEquity > plain.summary.finalEquity + 0.01;
        if (aheadHold && aheadPlain) both += 1;
        if (kind === "bull") {
          bullN += 1;
          if (aheadHold && aheadPlain) bullBoth += 1;
        }
        if (kind === "bear") {
          bearN += 1;
          if (aheadHold && aheadPlain) bearBoth += 1;
        }
        if (name === "from-2021-11") excess.push(intel.summary.finalEquity - intel.summary.holdFinal);
      }
    }
    excess.sort((a, b) => a - b);
    const mid = excess.length ? excess[Math.floor(excess.length / 2)] : null;
    const row = {
      book,
      id,
      n,
      skipped,
      bothRate: n ? both / n : 0,
      bullRate: bullN ? bullBoth / bullN : 0,
      bearRate: bearN ? bearBoth / bearN : 0,
      bullN,
      bearN,
      medianExcessHoldFull: mid,
      seconds: (Date.now() - started) / 1000,
    };
    bookRows.push(row);
    console.log(book, id, `both ${(100 * row.bothRate).toFixed(1)} bull ${(100 * row.bullRate).toFixed(1)} bear ${(100 * row.bearRate).toFixed(1)} n ${n} skip ${skipped} med ${mid == null ? "na" : Math.round(mid)} ${row.seconds.toFixed(0)}s`);
  }
}

writeFileSync(
  "results/remaining-scores.json",
  JSON.stringify({ at: new Date().toISOString(), pair: pairRows, books: bookRows }, null, 2),
);
console.log("wrote results/remaining-scores.json");
