/**
 * Replay the draft books and a bounded 3-coin scan on the stored candles.
 * Writes docs/data/preset_study.json for the page. Numbers come only from this run.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { pairCorrelation } from "../engine/correlation.ts";
import { parseCandleCsv } from "../engine/csv.ts";
import { simulate } from "../engine/simulate.ts";
import type { CandleSeries, Frequency, SimInput, SimSuccess } from "../engine/types.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "docs", "data");
const DAY = 86_400_000;
const YEAR = 365.25 * DAY;

const FOCUS = [
  "BTC", "ETH", "SOL", "HBAR", "TAO", "PENDLE", "ZEC", "UNI", "ENA", "NEAR",
  "AAVE", "LINK", "ADA", "SUI", "AVAX", "INJ", "WLD", "ONDO", "ATOM", "ARB",
  "LDO", "RUNE", "RENDER", "SKY", "GRAM",
];

interface Stat {
  multiple: number;
  cagr: number;
  maxDrawdown: number;
  sharpe: number;
  dragUsdt: number;
  trapEvents: number;
  rebalances: number;
  finalUsdt: number;
}

interface Draft {
  name: string;
  symbols: string[];
  weights: number[];
  frequency: Frequency;
  start: string;
  end: string;
  years: number;
  plain: Stat;
  guarded: Stat;
  holdMultiple: number;
  btcMultiple: number | null;
}

function loadSeries(symbol: string): CandleSeries {
  const bytes = fs.readFileSync(path.join(dataDir, "candles", `${symbol}.csv.gz`));
  const text = zlib.gunzipSync(bytes).toString("utf8");
  return parseCandleCsv(text, symbol);
}

function stat(result: SimSuccess): Stat {
  const s = result.summary;
  return {
    multiple: s.finalEquity / 10_000,
    cagr: s.cagr,
    maxDrawdown: s.maxDrawdown,
    sharpe: s.sharpe,
    dragUsdt: s.dragUsdt,
    trapEvents: s.trapEvents,
    rebalances: s.rebalances,
    finalUsdt: s.finalEquity,
  };
}

function runBook(
  symbols: string[],
  weights: number[],
  frequency: Frequency,
  series: Record<string, CandleSeries>,
  btc: CandleSeries,
  startMs: number,
  endMs: number,
  guarded: boolean,
): SimSuccess | null {
  const input: SimInput = {
    assets: symbols.map((symbol, i) => ({ symbol, weight: weights[i] ?? 1, sellLocked: false })),
    startMs,
    endMs,
    initialUsdt: 10_000,
    feeBps: 10,
    slippageBps: 5,
    frequency,
    band: guarded ? 0.05 : 0,
    fraction: guarded ? 0.5 : 1,
    trend: { enabled: guarded, smaDays: 60 },
    blockedBuyPolicy: "keep_winners",
    series,
    btc,
  };
  const result = simulate(input);
  return result.ok ? result : null;
}

function windowFor(symbols: string[], series: Record<string, CandleSeries>, endMs: number): { start: number; end: number } | null {
  let start = endMs - 3 * YEAR;
  for (const symbol of symbols) {
    const candles = series[symbol];
    if (!candles || candles.t.length === 0) return null;
    start = Math.max(start, candles.t[0]);
    endMs = Math.min(endMs, candles.t[candles.t.length - 1]);
  }
  if (endMs - start < 1.5 * YEAR) return null;
  return { start, end: endMs };
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function combinations<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]) => {
    if (acc.length === size) {
      out.push(acc.slice());
      return;
    }
    for (let i = start; i < items.length; i++) {
      acc.push(items[i]);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  pick(0, []);
  return out;
}

function main(): void {
  const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, "manifest.json"), "utf8")) as {
    generated_at: string;
    coins: Array<{ symbol: string; end: string }>;
  };
  const available = new Set(manifest.coins.map((coin) => coin.symbol));
  const symbols = FOCUS.filter((symbol) => available.has(symbol));
  const series: Record<string, CandleSeries> = {};
  for (const symbol of symbols) series[symbol] = loadSeries(symbol);
  const btc = series.BTC;
  if (!btc) throw new Error("BTC candles are required");
  const endMs = Date.parse(manifest.coins.find((coin) => coin.symbol === "BTC")?.end ?? btc.t[btc.t.length - 1].toString());

  const drafts: Draft[] = [];
  const books: Array<{ name: string; symbols: string[]; weights: number[]; frequencies: Frequency[] }> = [
    { name: "BTC untouched", symbols: ["BTC"], weights: [100], frequencies: ["none"] },
    { name: "TAO / PENDLE / HBAR", symbols: ["TAO", "PENDLE", "HBAR"], weights: [33, 33, 34], frequencies: ["weekly", "biweekly", "monthly"] },
    { name: "TAO / ZEC / PENDLE", symbols: ["TAO", "ZEC", "PENDLE"], weights: [33, 33, 34], frequencies: ["weekly", "monthly"] },
    { name: "TAO / UNI / ENA", symbols: ["TAO", "UNI", "ENA"], weights: [33, 33, 34], frequencies: ["weekly", "monthly"] },
    { name: "BTC / ETH", symbols: ["BTC", "ETH"], weights: [80, 20], frequencies: ["monthly", "none"] },
  ];
  for (const book of books) {
    if (book.symbols.some((symbol) => !series[symbol])) {
      console.log("skip missing", book.name);
      continue;
    }
    const span = windowFor(book.symbols, series, endMs);
    if (!span) {
      console.log("skip short", book.name);
      continue;
    }
    for (const frequency of book.frequencies) {
      const plain = runBook(book.symbols, book.weights, frequency, series, btc, span.start, span.end, false);
      const guarded = runBook(book.symbols, book.weights, frequency, series, btc, span.start, span.end, true);
      if (!plain || !guarded) continue;
      drafts.push({
        name: book.name,
        symbols: book.symbols,
        weights: book.weights,
        frequency,
        start: iso(plain.startMs),
        end: iso(plain.endMs),
        years: (plain.endMs - plain.startMs) / YEAR,
        plain: stat(plain),
        guarded: stat(guarded),
        holdMultiple: plain.summary.holdFinal / 10_000,
        btcMultiple: plain.summary.btcFinal == null ? null : plain.summary.btcFinal / 10_000,
      });
      console.log(
        `${book.name} ${frequency} plain ${drafts.at(-1)?.plain.multiple.toFixed(2)} guarded ${drafts.at(-1)?.guarded.multiple.toFixed(2)} hold ${drafts.at(-1)?.holdMultiple.toFixed(2)}`,
      );
    }
  }

  const scanUniverse = symbols.filter((symbol) => symbol !== "BTC" && windowFor([symbol, "BTC"], series, endMs));
  const ranked: Array<{ symbols: string[]; sharpe: number; multiple: number; holdMultiple: number; drag: number; premium: number }> = [];
  const combos = combinations(scanUniverse, 3);
  console.log(`scanning ${combos.length} baskets`);
  const spanCache = new Map<string, { start: number; end: number } | null>();
  for (const combo of combos) {
    const key = combo.join(",");
    let span = spanCache.get(key);
    if (span === undefined) {
      span = windowFor(combo, series, endMs);
      spanCache.set(key, span);
    }
    if (!span) continue;
    const plain = runBook(combo, [1, 1, 1], "monthly", series, btc, span.start, span.end, false);
    const guarded = runBook(combo, [1, 1, 1], "monthly", series, btc, span.start, span.end, true);
    if (!plain || !guarded) continue;
    ranked.push({
      symbols: combo,
      sharpe: guarded.summary.sharpe,
      multiple: guarded.summary.finalEquity / 10_000,
      holdMultiple: plain.summary.holdFinal / 10_000,
      drag: plain.summary.dragUsdt,
      premium: plain.summary.finalEquity / plain.summary.holdFinal - 1,
    });
  }
  ranked.sort((a, b) => b.sharpe - a.sharpe);

  const pairs: Array<{ a: string; b: string; all: number; btcUp: number | null; btcDown: number | null }> = [];
  const pairStart = endMs - 2 * YEAR;
  for (let i = 0; i < scanUniverse.length; i++) {
    for (let j = i + 1; j < scanUniverse.length; j++) {
      const corr = pairCorrelation(series[scanUniverse[i]], series[scanUniverse[j]], btc, pairStart, endMs);
      if (corr.all == null) continue;
      pairs.push({
        a: scanUniverse[i],
        b: scanUniverse[j],
        all: corr.all,
        btcUp: corr.btcUp,
        btcDown: corr.btcDown,
      });
    }
  }
  pairs.sort((a, b) => a.all - b.all);

  const payload = {
    generated_at: new Date().toISOString(),
    data_generated_at: manifest.generated_at,
    capital_usdt: 10_000,
    fee_bps: 10,
    slippage_bps: 5,
    guard: "5 percentage-point band, close half the gap, do not buy below the 60-day average, leave blocked cash in the winners",
    note: "One historical window per book, ending at the last stored candle. A higher past Sharpe is not a forecast. Baskets need 1.5 years of shared history and the scan uses equal weights with a monthly clock.",
    drafts,
    scan: {
      universe: scanUniverse,
      bestGuardedSharpe: ranked.slice(0, 8),
      largestPlainDrag: [...ranked].sort((a, b) => b.drag - a.drag).slice(0, 8),
      strongestRebalancePremium: [...ranked].sort((a, b) => b.premium - a.premium).slice(0, 8),
      lowestCorrelation: pairs.slice(0, 8),
      highestCorrelation: [...pairs].sort((a, b) => b.all - a.all).slice(0, 5),
    },
  };
  fs.writeFileSync(path.join(dataDir, "preset_study.json"), JSON.stringify(payload, null, 2) + "\n");
  console.log(`wrote study drafts=${drafts.length} baskets=${ranked.length}`);
}

main();
