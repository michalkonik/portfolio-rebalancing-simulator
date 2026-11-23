import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseCandleCsv } from "../engine/csv.ts";
import { simulate } from "../engine/simulate.ts";
import type { CandleSeries, IntelligentSpec } from "../engine/types.ts";

interface FileShape {
  groups: Array<{ id: string; title: string; portfolios: string[][] }>;
  time_ranges: Array<[string, string, string]>;
}

const file = JSON.parse(readFileSync("/home/mkoniu/Desktop/rebalance-portfolios.json", "utf8")) as FileShape;
const windows = file.time_ranges.map(([name, start, end]) => ({
  name,
  startMs: Date.parse(`${start}T00:00:00Z`),
  endMs: Date.parse(`${end}T23:59:59Z`),
}));

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

const common = {
  enabled: true,
  score: "absolute" as const,
  momentumDays: 30,
  trendDays: 50,
  leaderWeight: 0.8,
  defense: "equal" as const,
};

type AlgoId = "btc-eth" | "alts-stable" | "btc-alts" | "alts";

const groupsFor: Record<AlgoId, string[]> = {
  alts: ["two-altcoins", "three-altcoins"],
  "btc-alts": ["btc-one-alt", "btc-two-alts"],
  "alts-stable": ["usdt-one-alt", "usdt-two-alts"],
  "btc-eth": ["btc-eth"],
};

interface Version {
  id: string;
  note: string;
  everyDays: number;
  spec: Record<AlgoId, IntelligentSpec>;
}

const versions: Version[] = [
  {
    id: "v1",
    note: "Shipped rules. Alts tilt while bitcoin is above its 100-day average and return to the entered weights below it. The other three books tilt while bitcoin is above its 200-day average and otherwise leave the book alone. Leader weight 80%, 30-day momentum, 50-day trend, every 14 days.",
    everyDays: 14,
    spec: {
      alts: { ...common, regime: "btc-mix", regimeDays: 100 },
      "btc-alts": { ...common, regime: "btc-stay", regimeDays: 200 },
      "alts-stable": { ...common, regime: "btc-stay", regimeDays: 200 },
      "btc-eth": { ...common, regime: "btc-stay", regimeDays: 200 },
    },
  },
  {
    id: "v2",
    note: "Alts only: if every selected coin is at or below its 50-day average, leave the book alone instead of tilting. Check every 28 days. The other three books stay on the v1 rule.",
    everyDays: 14,
    spec: {
      alts: { ...common, regime: "alldown-stay" },
      "btc-alts": { ...common, regime: "btc-stay", regimeDays: 200 },
      "alts-stable": { ...common, regime: "btc-stay", regimeDays: 200 },
      "btc-eth": { ...common, regime: "btc-stay", regimeDays: 200 },
    },
  },
];

function daysFor(version: Version, algo: AlgoId): number {
  if (version.id === "v2" && algo === "alts") return 28;
  return version.everyDays;
}

function run(symbols: string[], startMs: number, endMs: number, spec: IntelligentSpec | null, everyDays: number) {
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
    everyDays,
    weekday: 1,
    band: 0,
    fraction: 1,
    trend: { enabled: false, smaDays: 50 },
    blockedBuyPolicy: "keep_winners",
    intelligent: spec ?? undefined,
  });
}

const books: Array<{ group: string; coins: string[] }> = [];
for (const group of file.groups) {
  for (const coins of group.portfolios) books.push({ group: group.id, coins });
}

const out = {
  generated: new Date().toISOString(),
  capital: 10_000,
  feeBps: 10,
  slippageBps: 5,
  windows,
  books,
  versions: [] as unknown[],
};

const computed = new Map<string, unknown>();

for (const version of versions) {
  const algos: Record<string, unknown> = {};
  for (const algo of Object.keys(groupsFor) as AlgoId[]) {
    const everyDays = daysFor(version, algo);
    const fingerprint = JSON.stringify({ algo, everyDays, spec: version.spec[algo] });
    const prior = computed.get(fingerprint);
    if (prior) {
      algos[algo] = prior;
      console.log(`${version.id} ${algo} reused`);
      continue;
    }
    const applicable = new Set(groupsFor[algo]);
    let eligible = 0;
    let beatHold = 0;
    let beatPlain = 0;
    let beatBoth = 0;
    let skipped = 0;
    let notApplicable = 0;
    const rows = [];
    const started = Date.now();
    for (const book of books) {
      const tests = [];
      if (!applicable.has(book.group)) {
        notApplicable += 1;
        rows.push({ group: book.group, coins: book.coins, applicable: false, tests: [] });
        continue;
      }
      for (const window of windows) {
        const intel = run(book.coins, window.startMs, window.endMs, version.spec[algo], everyDays);
        const plain = run(book.coins, window.startMs, window.endMs, null, everyDays);
        if (!intel.ok || !plain.ok) {
          skipped += 1;
          tests.push({
            window: window.name,
            ok: false,
            error: !intel.ok ? intel.error : plain.ok ? "" : plain.error,
          });
          continue;
        }
        const finalEquity = intel.summary.finalEquity;
        const hold = intel.summary.holdFinal;
        const plainFinal = plain.summary.finalEquity;
        const aheadHold = finalEquity > hold + 0.01;
        const aheadPlain = finalEquity > plainFinal + 0.01;
        eligible += 1;
        if (aheadHold) beatHold += 1;
        if (aheadPlain) beatPlain += 1;
        if (aheadHold && aheadPlain) beatBoth += 1;
        tests.push({
          window: window.name,
          ok: true,
          finalEquity,
          hold,
          plain: plainFinal,
          aheadHold,
          aheadPlain,
          aheadBoth: aheadHold && aheadPlain,
        });
      }
      rows.push({ group: book.group, coins: book.coins, applicable: true, tests });
    }
    const rate = (n: number) => (eligible ? n / eligible : 0);
    console.log(
      `${version.id} ${algo} every ${everyDays}d both ${(100 * rate(beatBoth)).toFixed(1)}% hold ${(100 * rate(beatHold)).toFixed(1)}% plain ${(100 * rate(beatPlain)).toFixed(1)}% n ${eligible} skip ${skipped} na ${notApplicable} ${((Date.now() - started) / 1000).toFixed(0)}s`,
    );
    const payload = {
      everyDays,
      spec: version.spec[algo],
      eligible,
      skipped,
      notApplicable,
      beatHold,
      beatPlain,
      beatBoth,
      beatHoldRate: rate(beatHold),
      beatPlainRate: rate(beatPlain),
      beatBothRate: rate(beatBoth),
      rows,
    };
    computed.set(fingerprint, payload);
    algos[algo] = payload;
  }
  out.versions.push({ id: version.id, note: version.note, algos });
}

mkdirSync("results", { recursive: true });
writeFileSync("results/validation.json", JSON.stringify(out));
console.log("wrote results/validation.json");
