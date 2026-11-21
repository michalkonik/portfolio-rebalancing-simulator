import { correlationMatrix } from "@engine/correlation.ts";
import { guardsAreActive, simulate, simulateNaive } from "@engine/simulate.ts";
import type { CandleSeries, Frequency, SimInput, SimSuccess } from "@engine/types.ts";
import { envelope, renderLineChart, renderStack, type ChartLine } from "./chart.ts";
import { cls, day, num, parseDayEnd, parseDayStart, pct, qty, quote, usdt } from "./format.ts";
import { loadCandles } from "./load.ts";

interface CoinInfo {
  symbol: string;
  name: string;
  pair: string;
  market_cap_rank: number | null;
  candles: number;
  start: string;
  end: string;
  path: string;
  history_note?: string;
}

interface Manifest {
  generated_at: string;
  interval: string;
  quote: string;
  source: string;
  requested_start: string;
  requested_end: string;
  notes?: string[];
  count: number;
  coins: CoinInfo[];
}

interface Holding {
  symbol: string;
  weight: string;
  sellLocked: boolean;
}

const BASE = import.meta.env.BASE_URL;
const PALETTE = ["#0d7680", "#0f5499", "#c04a1a", "#067647", "#5c3d8a", "#8c4a12", "#1b4f72", "#9b2c5a", "#3e5c1a", "#6e2c3a"];

interface ChartSpec {
  id: string;
  name: string;
  color: string;
  dash?: string;
  width?: number;
  axis: "left" | "right";
  on: boolean;
  values: Array<number | null>;
  label: (value: number) => string;
}

type PathStep = "day" | "week" | "month" | "bar";
const FREQUENCIES: Frequency[] = ["none", "daily", "weekly", "biweekly", "monthly"];

const PRESETS: Array<{ id: string; name: string; frequency: Frequency; holdings: Holding[] }> = [
  { id: "btc", name: "BTC untouched", frequency: "none", holdings: [{ symbol: "BTC", weight: "100", sellLocked: true }] },
  {
    id: "chat",
    name: "TAO PENDLE HBAR",
    frequency: "weekly",
    holdings: [
      { symbol: "TAO", weight: "33", sellLocked: false },
      { symbol: "PENDLE", weight: "33", sellLocked: false },
      { symbol: "HBAR", weight: "34", sellLocked: false },
    ],
  },
  {
    id: "sheet-a",
    name: "TAO ZEC PENDLE",
    frequency: "weekly",
    holdings: [
      { symbol: "TAO", weight: "33", sellLocked: false },
      { symbol: "ZEC", weight: "33", sellLocked: false },
      { symbol: "PENDLE", weight: "34", sellLocked: false },
    ],
  },
  {
    id: "sheet-b",
    name: "TAO UNI ENA",
    frequency: "weekly",
    holdings: [
      { symbol: "TAO", weight: "33", sellLocked: false },
      { symbol: "UNI", weight: "33", sellLocked: false },
      { symbol: "ENA", weight: "34", sellLocked: false },
    ],
  },
];

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing app root");

let manifest: Manifest | null = null;
let holdings: Holding[] = PRESETS[1].holdings.map((row) => ({ ...row }));
let lastDraw: (() => void) | null = null;
let applyBook: ((rows: Holding[], frequency: Frequency, start: string, end: string) => void) | null = null;

const ui = {
  sim: el("section", "sim"),
  corr: el("section", "corr"),
  data: el("section", "data"),
};
ui.corr.hidden = true;
ui.data.hidden = true;
app.append(ui.sim, ui.corr, ui.data);

document.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    const tab = button.dataset.tab;
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("on", item === button));
    ui.sim.hidden = tab !== "sim";
    ui.corr.hidden = tab !== "corr";
    ui.data.hidden = tab !== "data";
    if (tab === "sim") lastDraw?.();
  });
});

void boot();

async function boot(): Promise<void> {
  ui.sim.append(el("p", "muted", "Loading the coin list…"));
  try {
    const response = await fetch(`${BASE}data/manifest.json`, { cache: "no-cache" });
    if (!response.ok) throw new Error(`manifest ${response.status}`);
    manifest = (await response.json()) as Manifest;
  } catch (error) {
    ui.sim.replaceChildren(el("p", "neg", `Could not read the coin list. ${message(error)}`));
    return;
  }
  renderSimulator();
  renderData();
  renderCorrelationShell();
  await run();
}

function renderSimulator(): void {
  if (!manifest) return;
  const dataEnd = manifest.coins.reduce((max, coin) => Math.max(max, Date.parse(coin.end)), 0);
  const defaultEnd = Number.isFinite(dataEnd) && dataEnd > 0 ? dataEnd : Date.now();
  const defaultStart = defaultEnd - 3 * 365.25 * 86_400_000;

  const layout = el("div", "layout");
  const form = el("form", "panel controls");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void run();
  });

  const presetRow = el("div", "presets");
  for (const preset of PRESETS) {
    const button = el("button");
    button.type = "button";
    button.textContent = preset.name;
    button.addEventListener("click", () => {
      holdings = preset.holdings.map((row) => ({ ...row }));
      frequency.value = preset.frequency;
      drawHoldings();
      void run();
    });
    presetRow.append(button);
  }
  form.append(presetRow);

  const search = el("input") as HTMLInputElement;
  search.placeholder = "Add a coin — BTC, TAO, or TON";
  search.autocomplete = "off";
  const suggest = el("div", "suggest");
  search.addEventListener("input", () => fillSuggest(suggest, search.value));
  form.append(field("Coins", search), suggest);

  const holdingHost = el("div");
  holdingHost.id = "holdings";
  form.append(holdingHost);
  const sum = el("p", "sum");
  sum.id = "weight-sum";
  form.append(sum);
  const equal = el("button", "btn ghost");
  equal.type = "button";
  equal.textContent = "Equal weight";
  equal.addEventListener("click", () => {
    if (holdings.length === 0) return;
    const each = Math.floor((10000 / holdings.length)) / 100;
    let used = 0;
    holdings.forEach((row, index) => {
      if (index === holdings.length - 1) row.weight = (100 - used).toFixed(2);
      else {
        row.weight = each.toFixed(2);
        used += each;
      }
    });
    drawHoldings();
  });
  form.append(equal);

  const capital = input("number", "10000");
  capital.min = "1";
  capital.step = "any";
  const start = input("date", day(defaultStart));
  const end = input("date", day(defaultEnd));
  const frequency = el("select") as HTMLSelectElement;
  for (const value of FREQUENCIES) {
    const option = el("option");
    option.value = value;
    option.textContent = labelFrequency(value);
    frequency.append(option);
  }
  frequency.value = "weekly";
  const fee = input("number", "10");
  fee.min = "0";
  fee.step = "1";
  const slip = input("number", "5");
  slip.min = "0";
  slip.step = "1";

  const dates = el("div", "field row");
  dates.append(labeled("Start, UTC", start), labeled("End, UTC", end));
  const costs = el("div", "field row");
  costs.append(labeled("Fee, bps", fee), labeled("Slippage, bps", slip));
  form.append(field("Starting capital", capital), dates, field("How often to look", frequency), costs);

  const band = input("number", "5");
  band.min = "0";
  band.max = "80";
  band.step = "0.5";
  const fraction = input("number", "50");
  fraction.min = "10";
  fraction.max = "100";
  fraction.step = "5";
  const trend = el("input") as HTMLInputElement;
  trend.type = "checkbox";
  trend.checked = true;
  const sma = input("number", "60");
  sma.min = "2";
  sma.max = "400";
  const policy = el("select") as HTMLSelectElement;
  for (const [value, text] of [
    ["keep_winners", "Leave it in the winners"],
    ["park_usdt", "Park it in USDT"],
  ] as const) {
    const option = el("option");
    option.value = value;
    option.textContent = text;
    policy.append(option);
  }

  const guard = el("div", "guard");
  guard.append(el("h3", "", "Don't sell a winner into a loser"));
  guard.append(
    el(
      "p",
      "hint",
      "A plain rebalance sells what went up and buys what went down. These controls refuse that trade unless you explicitly allow it.",
    ),
  );
  guard.append(field("Drift band, percentage points", band));
  guard.append(el("p", "hint", "A 33% target and a band of 5 trades only outside 28–38%."));
  guard.append(field("How much of the gap to close, %", fraction));
  const trendRow = el("label", "check");
  trendRow.append(trend, document.createTextNode("Do not buy a coin below its moving average"));
  guard.append(trendRow, field("Moving average, days", sma), field("If a buy is blocked", policy));
  const protect = el("button", "btn ghost");
  protect.type = "button";
  protect.textContent = "Protect winners";
  protect.addEventListener("click", () => {
    band.value = "5";
    fraction.value = "50";
    trend.checked = true;
    sma.value = "60";
    policy.value = "keep_winners";
    void run();
  });
  const naiveBtn = el("button", "btn ghost");
  naiveBtn.type = "button";
  naiveBtn.textContent = "Plain rebalance";
  naiveBtn.addEventListener("click", () => {
    band.value = "0";
    fraction.value = "100";
    trend.checked = false;
    policy.value = "keep_winners";
    void run();
  });
  const actions = el("div", "actions");
  const runBtn = el("button", "btn primary");
  runBtn.type = "submit";
  runBtn.textContent = "Run";
  actions.append(runBtn, protect, naiveBtn);
  guard.append(actions);
  form.append(guard);

  const results = el("div", "results");
  results.id = "results";
  layout.append(form, results);
  const studyHost = el("div", "study");
  ui.sim.replaceChildren(studyHost, layout);
  void loadStudy(studyHost);

  function drawHoldings(): void {
    holdingHost.replaceChildren();
    for (const holding of holdings) {
      const row = el("div", "coin-row");
      const meta = el("div", "meta");
      meta.append(el("strong", "", holding.symbol));
      const info = coinInfo(holding.symbol);
      meta.append(el("span", "", info ? `${info.name} · from ${info.start.slice(0, 10)}` : holding.symbol === "USDT" ? "Cash at 1 USDT" : "Not in the data set"));
      const weight = input("number", holding.weight);
      weight.min = "0";
      weight.step = "any";
      weight.addEventListener("input", () => {
        holding.weight = weight.value;
        paintSum();
      });
      const lock = el("label", "lock");
      const box = el("input") as HTMLInputElement;
      box.type = "checkbox";
      box.checked = holding.sellLocked;
      box.addEventListener("change", () => {
        holding.sellLocked = box.checked;
      });
      lock.append(box, document.createTextNode("Lock"));
      const remove = el("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        holdings = holdings.filter((item) => item !== holding);
        drawHoldings();
      });
      row.append(meta, weight, lock, remove);
      holdingHost.append(row);
    }
    paintSum();
  }

  function paintSum(): void {
    const total = holdings.reduce((sumWeights, row) => sumWeights + (Number(row.weight) || 0), 0);
    sum.textContent = holdings.length
      ? `Entered weights sum to ${total.toFixed(2)}. Any positive mix is normalized to 100% before the run.`
      : "Add between 1 and 10 coins.";
    sum.classList.toggle("bad", holdings.length < 1 || holdings.length > 10);
  }

  function fillSuggest(host: HTMLElement, query: string): void {
    host.replaceChildren();
    const q = query.trim().toLowerCase();
    if (!q || !manifest) return;
    const matches: Array<{ symbol: string; name: string }> = [];
    if ("usdt".startsWith(q) || "cash".startsWith(q) || q === "usd") matches.push({ symbol: "USDT", name: "Cash sleeve" });
    const alias = q === "ton" || q === "toncoin" ? "GRAM" : "";
    for (const coin of manifest.coins) {
      const hay = `${coin.symbol} ${coin.name}`.toLowerCase();
      if (coin.symbol === alias || hay.includes(q)) matches.push({ symbol: coin.symbol, name: coin.name });
      if (matches.length >= 8) break;
    }
    for (const match of matches) {
      const button = el("button");
      button.type = "button";
      button.append(document.createTextNode(`${match.symbol} `), el("small", "", match.name));
      button.addEventListener("click", () => {
        if (holdings.some((row) => row.symbol === match.symbol)) return;
        if (holdings.length >= 10) return;
        holdings.push({ symbol: match.symbol, weight: "0", sellLocked: false });
        search.value = "";
        host.replaceChildren();
        drawHoldings();
      });
      host.append(button);
    }
  }

  drawHoldings();
  applyBook = (rows, freq, startValue, endValue) => {
    holdings = rows.map((row) => ({ ...row }));
    frequency.value = freq;
    start.value = startValue;
    end.value = endValue;
    drawHoldings();
    void run();
  };

  async function run(): Promise<void> {
    if (!manifest) return;
    results.replaceChildren(el("p", "muted", "Running…"));
    const built = buildInput(capital, start, end, frequency, fee, slip, band, fraction, trend, sma, policy);
    if (typeof built === "string") {
      results.replaceChildren(el("p", "neg", built));
      return;
    }
    try {
      const { series, btc } = await loadBook(built.symbols);
      const input: SimInput = { ...built.input, series, btc };
      const result = simulate(input);
      if (!result.ok) {
        results.replaceChildren(el("p", "neg", result.error));
        return;
      }
      const naive = guardsAreActive(input) ? simulateNaive(input) : null;
      const comparisons = FREQUENCIES.map((value) => {
        const ran = simulate({ ...input, frequency: value });
        return ran.ok ? { frequency: value, result: ran } : null;
      }).filter((row): row is { frequency: Frequency; result: SimSuccess } => row != null);
      paintResults(results, result, naive && naive.ok ? naive : null, comparisons);
    } catch (error) {
      results.replaceChildren(el("p", "neg", message(error)));
    }
  }

  (window as unknown as { __run?: () => Promise<void> }).__run = run;
}

async function run(): Promise<void> {
  const runner = (window as unknown as { __run?: () => Promise<void> }).__run;
  if (runner) await runner();
}

function buildInput(
  capital: HTMLInputElement,
  start: HTMLInputElement,
  end: HTMLInputElement,
  frequency: HTMLSelectElement,
  fee: HTMLInputElement,
  slip: HTMLInputElement,
  band: HTMLInputElement,
  fraction: HTMLInputElement,
  trend: HTMLInputElement,
  sma: HTMLInputElement,
  policy: HTMLSelectElement,
): { symbols: string[]; input: Omit<SimInput, "series" | "btc"> } | string {
  if (holdings.length < 1 || holdings.length > 10) return "Choose between 1 and 10 coins.";
  if (holdings.every((row) => row.symbol === "USDT")) return "USDT alone has no price history. Pair it with a coin.";
  const initialUsdt = Number(capital.value);
  const startMs = parseDayStart(start.value);
  const endMs = parseDayEnd(end.value);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "Enter a start and an end date.";
  const assets = holdings.map((row) => ({
    symbol: row.symbol,
    weight: Number(row.weight),
    sellLocked: row.sellLocked,
  }));
  return {
    symbols: assets.map((asset) => asset.symbol),
    input: {
      assets,
      startMs,
      endMs,
      initialUsdt,
      feeBps: Number(fee.value),
      slippageBps: Number(slip.value),
      frequency: frequency.value as Frequency,
      band: Number(band.value) / 100,
      fraction: Number(fraction.value) / 100,
      trend: { enabled: trend.checked, smaDays: Number(sma.value) },
      blockedBuyPolicy: policy.value === "park_usdt" ? "park_usdt" : "keep_winners",
    },
  };
}

async function loadBook(symbols: string[]): Promise<{ series: Record<string, CandleSeries>; btc: CandleSeries | null }> {
  const needed = new Set(symbols.filter((symbol) => symbol !== "USDT"));
  needed.add("BTC");
  const series: Record<string, CandleSeries> = {};
  await Promise.all(
    [...needed].map(async (symbol) => {
      const info = coinInfo(symbol);
      if (!info) throw new Error(`${symbol} is not in the downloaded universe.`);
      series[symbol] = await loadCandles(`${BASE}${info.path}?v=${manifest?.generated_at ?? "1"}`, symbol);
    }),
  );
  return { series, btc: series.BTC ?? null };
}

function paintResults(
  host: HTMLElement,
  result: SimSuccess,
  naive: SimSuccess | null,
  comparisons: Array<{ frequency: Frequency; result: SimSuccess }>,
): void {
  host.replaceChildren();
  for (const warning of result.warnings) host.append(el("p", "warn", warning));
  host.append(narrative(result, naive));

  const stats = el("div", "stats");
  const s = result.summary;
  for (const [label, value, klass] of [
    ["Final value", usdt(s.finalEquity), ""],
    ["Total return", pct(s.totalReturn), cls(s.totalReturn)],
    ["CAGR", pct(s.cagr), cls(s.cagr)],
    ["Max drawdown", pct(s.maxDrawdown), "neg"],
    ["Sharpe", num(s.sharpe), ""],
    ["Volatility", pct(s.volatility), ""],
    ["Fees paid", usdt(s.fees), ""],
    ["Turnover", usdt(s.turnover), ""],
    ["Rebalances", String(s.rebalances), ""],
    ["Sold strength", String(s.trapEvents), s.trapEvents ? "neg" : ""],
    ["Winner drag", usdt(s.dragUsdt), cls(-s.dragUsdt)],
    ["Vs hold", usdt(s.finalEquity - s.holdFinal), cls(s.finalEquity - s.holdFinal)],
  ] as const) {
    const card = el("div", "stat");
    const strong = el("strong", klass, value);
    card.append(el("span", "", label), strong);
    stats.append(card);
  }
  host.append(stats);

  const chartCard = el("div", "chart-card");
  chartCard.append(el("h2", "", "Value over time"));
  chartCard.append(el(
    "p",
    "hint",
    "Linear scale. Coin lines are the USDT value of the coins this book is holding. The left axis is USDT. BTC price uses the right axis, so a high bitcoin price does not flatten the book. Hide any line and the chart rescales.",
  ));
  const chart = el("div", "chart");
  const legend = el("div", "legend");
  chartCard.append(chart, legend);
  host.append(chartCard);

  const weightCard = el("div", "chart-card");
  weightCard.append(el("h2", "", "Weights"));
  const weights = el("div", "chart");
  weightCard.append(weights);
  host.append(weightCard);

  const times = result.points.map((point) => point.t);
  const money = (value: number) => usdt(value);
  const btcLabel = (value: number) => `${quote(value)} USDT`;
  const specs: ChartSpec[] = [
    {
      id: "equity",
      name: "Portfolio",
      color: "#990f3d",
      width: 2.6,
      axis: "left",
      on: true,
      values: result.points.map((point) => point.equity),
      label: money,
    },
  ];
  result.assets.forEach((asset, index) => {
    specs.push({
      id: `coin:${asset.symbol}`,
      name: asset.symbol,
      color: PALETTE[index % PALETTE.length],
      width: 1.7,
      axis: "left",
      on: true,
      values: result.points.map((point) => point.values[index] ?? null),
      label: money,
    });
  });
  if (result.points.some((point) => point.usdt > 1)) {
    specs.push({
      id: "cash",
      name: "USDT cash",
      color: "#6b5e53",
      width: 1.4,
      axis: "left",
      on: false,
      values: result.points.map((point) => point.usdt),
      label: money,
    });
  }
  specs.push({
    id: "hold",
    name: "Hold",
    color: "#0f5499",
    dash: "3 3",
    width: 1.5,
    axis: "left",
    on: false,
    values: result.points.map((point) => point.hold),
    label: money,
  });
  if (naive) {
    const naiveAt = new Map(naive.points.map((point) => [point.t, point.equity]));
    specs.push({
      id: "unguarded",
      name: "Unguarded",
      color: "#c04a1a",
      dash: "6 4",
      width: 1.5,
      axis: "left",
      on: false,
      values: times.map((time) => naiveAt.get(time) ?? null),
      label: money,
    });
  }
  if (result.points.some((point) => point.btcPrice != null)) {
    specs.push({
      id: "btc-price",
      name: "BTC price",
      color: "#262a33",
      dash: "5 3",
      width: 1.8,
      axis: "right",
      on: true,
      values: result.points.map((point) => point.btcPrice),
      label: btcLabel,
    });
  }

  const hidden = new Set(specs.filter((spec) => !spec.on).map((spec) => spec.id));
  for (const spec of specs) {
    const item = el("label", spec.on ? "" : "off");
    const box = el("input") as HTMLInputElement;
    box.type = "checkbox";
    box.checked = spec.on;
    const swatch = el("i");
    swatch.style.background = spec.color;
    item.append(box, swatch, document.createTextNode(spec.name));
    box.addEventListener("change", () => {
      if (box.checked) hidden.delete(spec.id);
      else hidden.add(spec.id);
      item.classList.toggle("off", !box.checked);
      paint();
    });
    legend.append(item);
  }

  const paint = () => {
    const lines: ChartLine[] = specs
      .filter((spec) => !hidden.has(spec.id))
      .map((spec) => ({
        name: spec.name,
        color: spec.color,
        dash: spec.dash,
        width: spec.width,
        axis: spec.axis,
        values: spec.values,
        label: spec.label,
      }));
    const packed = lines.length > 0 ? envelope(times, lines, 720) : { times, lines };
    renderLineChart(chart, packed.times, packed.lines, { left: "USDT", right: "BTC price" });
    const stride = Math.max(1, Math.floor(result.points.length / 300));
    const sample = result.points.filter((_, index) => index % stride === 0 || index === result.points.length - 1);
    const stack = result.assets.map((asset, index) => ({
      name: asset.symbol,
      color: PALETTE[index % PALETTE.length],
      values: sample.map((point) => point.weights[index] ?? 0),
    }));
    const residual = sample.map((point) => Math.max(0, 1 - point.weights.reduce((sum, value) => sum + value, 0)));
    if (residual.some((value) => value > 0.01)) {
      stack.push({ name: "USDT", color: "#6b5e53", values: residual });
    }
    renderStack(weights, sample.map((point) => point.t), stack);
  };
  lastDraw = paint;
  paint();

  host.append(pathTable(result));
  host.append(frequencyTable(comparisons));
  host.append(holdingsTable(result));
  host.append(yearTable(result));
  host.append(tradeTable(result));

  const exports = el("div", "links");
  const equityBtn = el("button", "btn ghost");
  equityBtn.type = "button";
  equityBtn.textContent = "Download value CSV";
  equityBtn.addEventListener("click", () => downloadCsv("portfolio-value.csv", equityCsv(result)));
  const tradeBtn = el("button", "btn ghost");
  tradeBtn.type = "button";
  tradeBtn.textContent = "Download trades CSV";
  tradeBtn.addEventListener("click", () => downloadCsv("rebalance-trades.csv", tradesCsv(result)));
  exports.append(equityBtn, tradeBtn);
  host.append(exports);
}

function dragSentence(events: number, drag: number): string {
  if (events === 0 || Math.abs(drag) < 1) return "There was no measured winner-to-laggard gap on this path.";
  const times = `${events} time${events === 1 ? "" : "s"}`;
  if (drag > 0) {
    return `It sold a coin with the stronger 30-day trail ${times}. Keeping those sold coins instead would have been ahead by about ${usdt(drag)} at the end.`;
  }
  return `It sold a coin with the stronger 30-day trail ${times}, but the coins that were bought later did better. That gap is ${usdt(drag)} (a negative gap means the sale helped on this path).`;
}

function narrative(result: SimSuccess, naive: SimSuccess | null): HTMLElement {
  const s = result.summary;
  const years = (result.endMs - result.startMs) / (365.25 * 86_400_000);
  const ahead = s.finalEquity >= s.holdFinal && s.totalReturn > 0;
  const banner = el("div", ahead ? "banner good" : "banner");
  const title = el("strong", "", `${usdt(s.finalEquity)} after ${years.toFixed(1)} years`);
  const text = el("p");
  const parts = [
    `The same weights, never rebalanced, finished at ${usdt(s.holdFinal)} (${pct(s.holdReturn)}).`,
  ];
  if (s.btcFinal != null && !(result.assets.length === 1 && result.assets[0]?.symbol === "BTC")) {
    parts.push(`Untouched BTC finished at ${usdt(s.btcFinal)} (${pct(s.btcReturn)}).`);
  }
  if (naive) {
    const delta = s.finalEquity - naive.summary.finalEquity;
    parts.push(
      `A plain rebalance of this book finished at ${usdt(naive.summary.finalEquity)}. The guards changed that by ${usdt(delta)}.`,
    );
    parts.push(dragSentence(naive.summary.trapEvents, naive.summary.dragUsdt));
  } else {
    parts.push(dragSentence(s.trapEvents, s.dragUsdt));
  }
  text.textContent = parts.join(" ");
  banner.append(title, text);
  return banner;
}

function frequencyTable(rows: Array<{ frequency: Frequency; result: SimSuccess }>): HTMLElement {
  const card = el("div", "table-card");
  card.append(el("h2", "", "Same book, other clocks"));
  card.append(el("p", "hint", "Guards, fees, and dates stay as you set them. Only the calendar changes."));
  const table = el("table");
  table.append(row("th", ["Clock", "Final", "CAGR", "Max DD", "Sharpe", "Fees", "Sold strength", "Drag"]));
  for (const item of rows) {
    const s = item.result.summary;
    table.append(row("td", [
      labelFrequency(item.frequency),
      usdt(s.finalEquity),
      pct(s.cagr),
      pct(s.maxDrawdown),
      num(s.sharpe),
      usdt(s.fees),
      String(s.trapEvents),
      usdt(s.dragUsdt),
    ]));
  }
  card.append(wrap(table));
  return card;
}

function pathTable(result: SimSuccess): HTMLElement {
  const card = el("div", "table-card");
  const head = el("div", "table-head");
  head.append(el("h2", "", "Numbers across time"));
  const step = el("select") as HTMLSelectElement;
  for (const [value, text] of [
    ["day", "Daily"],
    ["week", "Weekly"],
    ["month", "Monthly"],
    ["bar", "Every 4h bar"],
  ] as const) {
    const option = el("option");
    option.value = value;
    option.textContent = text;
    step.append(option);
  }
  head.append(step);
  card.append(head);
  const note = el("p", "hint");
  const scroller = el("div", "table-scroll tall");
  card.append(note, scroller);
  const fill = () => {
    const rows = samplePoints(result.points, step.value as PathStep);
    note.textContent = `${rows.length.toLocaleString("en-US")} marks. Each coin column is the USDT value of the coins held. The CSV has every 4h bar, including quantities.`;
    const table = el("table");
    const head = el("thead");
    head.append(row("th", [
      "Date",
      "Portfolio",
      ...result.assets.map((asset) => asset.symbol),
      "BTC price",
    ]));
    const body = el("tbody");
    for (const point of rows) {
      body.append(row("td", [
        day(point.t),
        usdt(point.equity),
        ...result.assets.map((_, index) => usdt(point.values[index] ?? 0)),
        point.btcPrice == null ? "—" : quote(point.btcPrice),
      ]));
    }
    table.append(head, body);
    scroller.replaceChildren(table);
  };
  step.addEventListener("change", fill);
  fill();
  return card;
}

function samplePoints(points: SimSuccess["points"], step: PathStep): SimSuccess["points"] {
  if (step === "bar" || points.length === 0) return points;
  const buckets = new Map<string, SimSuccess["points"][number]>();
  const order: string[] = [];
  for (const point of points) {
    const key = bucketKey(point.t, step);
    if (!buckets.has(key)) order.push(key);
    buckets.set(key, point);
  }
  return order.map((key) => buckets.get(key)!);
}

function bucketKey(ms: number, step: Exclude<PathStep, "bar">): string {
  const date = new Date(ms);
  if (step === "month") return date.toISOString().slice(0, 7);
  if (step === "day") return date.toISOString().slice(0, 10);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function holdingsTable(result: SimSuccess): HTMLElement {
  const card = el("div", "table-card");
  card.append(el("h2", "", "Coins held"));
  const table = el("table");
  table.append(row("th", ["Coin", "Target", "Start units", "End units", "End weight", "End value"]));
  const first = result.points[0];
  const last = result.points[result.points.length - 1];
  result.assets.forEach((asset, index) => {
    const endQty = last.qty[index] ?? 0;
    const price = endQty > 0 ? (last.weights[index] * last.equity) / endQty : 0;
    table.append(row("td", [
      asset.symbol + (asset.sellLocked ? " locked" : ""),
      pct(asset.weight, 2),
      qty(first.qty[index] ?? 0),
      qty(endQty),
      pct(last.weights[index] ?? 0, 1),
      usdt(endQty * price),
    ]));
  });
  if (last.usdt > 0.01) {
    table.append(row("td", ["USDT", "residual", "—", qty(last.usdt), pct(last.usdt / last.equity, 1), usdt(last.usdt)]));
  }
  card.append(wrap(table));
  return card;
}

function yearTable(result: SimSuccess): HTMLElement {
  const card = el("div", "table-card");
  card.append(el("h2", "", "Calendar years"));
  const table = el("table");
  table.append(row("th", ["Year", "Strategy", "Hold", "BTC"]));
  for (const year of result.years) {
    table.append(row("td", [String(year.year), pct(year.strategy), pct(year.hold), year.btc == null ? "—" : pct(year.btc)]));
  }
  card.append(wrap(table));
  return card;
}

function tradeTable(result: SimSuccess): HTMLElement {
  const card = el("div", "table-card");
  card.append(el("h2", "", "Trades"));
  const trades = result.events.flatMap((event) => event.trades.map((trade) => ({ trade, flag: event.soldStrengthToWeakness })));
  if (trades.length === 0) {
    card.append(el("p", "hint", "No rebalance traded. The book was inside its band, or nothing was allowed to move."));
    return card;
  }
  const shown = trades.slice(0, 180);
  const table = el("table");
  table.append(row("th", ["Date", "Side", "Coin", "Units", "Price", "Value", "30d trail", "Note"]));
  for (const item of shown) {
    const trade = item.trade;
    table.append(row("td", [
      day(trade.t),
      trade.side,
      trade.symbol,
      qty(trade.qty),
      trade.price.toPrecision(6),
      usdt(trade.notional),
      trade.trail == null ? "—" : pct(trade.trail),
      item.flag && trade.side === "sell" ? "sold strength" : "",
    ]));
  }
  card.append(wrap(table));
  if (trades.length > shown.length) {
    card.append(el("p", "hint", `Showing the first ${shown.length} of ${trades.length} fills. The CSV has every fill.`));
  }
  return card;
}

function renderCorrelationShell(): void {
  const panel = el("div", "panel");
  panel.append(el("h2", "", "Do these coins move together?"));
  panel.append(el("p", "hint", "Daily log-return correlation over the dates in the simulator. BTC-up and BTC-down use the sign of Bitcoin's own day, even if Bitcoin is not in the book."));
  const button = el("button", "btn primary");
  button.type = "button";
  button.textContent = "Calculate for the selected coins";
  const out = el("div", "results");
  button.addEventListener("click", () => void calculateCorrelation(out));
  const pair = el("div", "field row");
  const left = el("select") as HTMLSelectElement;
  const right = el("select") as HTMLSelectElement;
  fillCoinSelect(left);
  fillCoinSelect(right);
  if (right.options.length > 1) right.selectedIndex = 1;
  const pairBtn = el("button", "btn ghost");
  pairBtn.type = "button";
  pairBtn.textContent = "One pair";
  const pairOut = el("p");
  pairBtn.addEventListener("click", () => void calculatePair(left.value, right.value, pairOut));
  pair.append(labeled("Coin A", left), labeled("Coin B", right));
  panel.append(button, pair, pairBtn, pairOut, out);
  ui.corr.replaceChildren(panel);
}

function fillCoinSelect(select: HTMLSelectElement): void {
  select.replaceChildren();
  for (const coin of manifest?.coins ?? []) {
    const option = el("option");
    option.value = coin.symbol;
    option.textContent = `${coin.symbol} — ${coin.name}`;
    select.append(option);
  }
}

async function calculateCorrelation(host: HTMLElement): Promise<void> {
  host.replaceChildren(el("p", "muted", "Calculating…"));
  const symbols = holdings.map((row) => row.symbol).filter((symbol) => symbol !== "USDT");
  if (symbols.length < 2) {
    host.replaceChildren(el("p", "neg", "Select at least two coins in the simulator."));
    return;
  }
  try {
    const { series, btc } = await loadBook(symbols);
    const dates = [...document.querySelectorAll<HTMLInputElement>("input[type=date]")];
    if (!dates[0] || !dates[1]) return;
    const matrix = correlationMatrix(
      symbols.map((symbol) => series[symbol]),
      btc,
      parseDayStart(dates[0].value),
      parseDayEnd(dates[1].value),
    );
    host.replaceChildren(
      heatTable(matrix.symbols, matrix.all, "Whole window"),
      heatTable(matrix.symbols, matrix.btcUp, "BTC up days"),
      heatTable(matrix.symbols, matrix.btcDown, "BTC down days"),
    );
  } catch (error) {
    host.replaceChildren(el("p", "neg", message(error)));
  }
}

async function calculatePair(a: string, b: string, host: HTMLElement): Promise<void> {
  if (!a || !b || a === b) {
    host.textContent = "Pick two different coins.";
    return;
  }
  host.textContent = "Calculating…";
  try {
    const { series, btc } = await loadBook([a, b]);
    const dates = [...document.querySelectorAll<HTMLInputElement>("input[type=date]")];
    const matrix = correlationMatrix([series[a], series[b]], btc, parseDayStart(dates[0].value), parseDayEnd(dates[1].value));
    const n = matrix.observations[0][1];
    host.textContent = `${a}/${b}: ${num(matrix.all[0][1], 2)} overall, ${num(matrix.btcUp[0][1], 2)} on BTC up days, ${num(matrix.btcDown[0][1], 2)} on BTC down days, ${n} daily returns.`;
  } catch (error) {
    host.textContent = message(error);
  }
}

function heatTable(symbols: string[], values: Array<Array<number | null>>, title: string): HTMLElement {
  const card = el("div", "table-card");
  card.append(el("h3", "", title));
  const table = el("table", "heat");
  const head = el("tr");
  head.append(el("th"));
  for (const symbol of symbols) head.append(el("th", "", symbol));
  table.append(head);
  symbols.forEach((symbol, i) => {
    const tr = el("tr");
    tr.append(el("th", "", symbol));
    symbols.forEach((_, j) => {
      const value = values[i][j];
      const cell = el("td", "", value == null ? "—" : value.toFixed(2));
      cell.style.background = corrColor(value);
      cell.style.color = value != null && Math.abs(value) > 0.55 ? "#fff1e5" : "#33302e";
      tr.append(cell);
    });
    table.append(tr);
  });
  card.append(wrap(table));
  return card;
}

function renderData(): void {
  if (!manifest) return;
  const panel = el("div", "panel");
  panel.append(el("h2", "", "Stored history"));
  panel.append(el("p", "hint", `${manifest.count} markets · ${manifest.interval} · ${manifest.source}. Generated ${manifest.generated_at}. Requested ${manifest.requested_start} to ${manifest.requested_end}.`));
  for (const note of manifest.notes ?? []) panel.append(el("p", "hint", note));
  panel.append(el("p", "hint", "PEAQ and GRASS have no Binance USDT spot market, so they are not in this book. Toncoin is GRAM: Binance renamed the market, and older TONUSDT candles are prepended when the stitch script has been run."));
  panel.append(el("h3", "", "Refresh later"));
  panel.append(el("p", "hint", "From a checkout: python3 scripts/download_data.py --update && python3 scripts/stitch_gram.py && node --experimental-strip-types scripts/build_study.ts"));
  panel.append(el("p", "hint", "Or run the GitHub Action “Update market data”. It writes new candles onto main. Reload this page afterwards."));
  const filter = input("search", "");
  filter.placeholder = "Filter coins";
  const tableHost = el("div");
  const paint = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = manifest!.coins.filter((coin) => `${coin.symbol} ${coin.name}`.toLowerCase().includes(q));
    const table = el("table");
    table.append(row("th", ["Rank", "Coin", "Name", "Candles", "From", "To"]));
    for (const coin of rows) {
      table.append(row("td", [
        coin.market_cap_rank == null ? "—" : String(coin.market_cap_rank),
        coin.symbol,
        coin.name,
        String(coin.candles),
        coin.start.slice(0, 10),
        coin.end.slice(0, 10),
      ]));
    }
    tableHost.replaceChildren(wrap(table));
  };
  filter.addEventListener("input", paint);
  panel.append(filter, tableHost);
  paint();
  ui.data.replaceChildren(panel);
}

async function loadStudy(host: HTMLElement): Promise<void> {
  let payload: StudyFile;
  try {
    const response = await fetch(`${BASE}data/preset_study.json`, { cache: "no-cache" });
    if (!response.ok) return;
    payload = (await response.json()) as StudyFile;
  } catch {
    return;
  }
  if (!payload.drafts?.length) return;
  const card = el("div", "table-card");
  card.append(el("h2", "", "Draft books on the stored history"));
  card.append(el("p", "hint", payload.note));
  card.append(el("p", "hint", `Guard used in the second column: ${payload.guard}. Fee ${payload.fee_bps} bps plus ${payload.slippage_bps} bps slippage, on ${usdt(payload.capital_usdt)}.`));
  const table = el("table");
  table.append(row("th", ["Book", "Clock", "Window", "Plain", "Guarded", "Hold", "BTC", "Plain drag"]));
  for (const draft of payload.drafts) {
    const tr = el("tr");
    const name = el("td");
    const button = el("button");
    button.type = "button";
    button.textContent = draft.name;
    button.className = "btn ghost";
    button.addEventListener("click", () => {
      applyBook?.(
        draft.symbols.map((symbol, index) => ({
          symbol,
          weight: String(draft.weights[index] ?? 1),
          sellLocked: symbol === "BTC" && draft.symbols.length === 1,
        })),
        draft.frequency,
        draft.start,
        draft.end,
      );
    });
    name.append(button);
    tr.append(name);
    for (const cell of [
      labelFrequency(draft.frequency),
      `${draft.start} → ${draft.end}`,
      `${draft.plain.multiple.toFixed(2)}×`,
      `${draft.guarded.multiple.toFixed(2)}×`,
      `${draft.holdMultiple.toFixed(2)}×`,
      draft.btcMultiple == null ? "—" : `${draft.btcMultiple.toFixed(2)}×`,
      usdt(draft.plain.dragUsdt),
    ]) {
      tr.append(el("td", "", cell));
    }
    table.append(tr);
  }
  card.append(wrap(table));
  if (payload.scan?.lowestCorrelation?.length) {
    card.append(el("h3", "", "Lowest correlations in the scan universe"));
    const pairs = el("p", "hint");
    pairs.textContent = payload.scan.lowestCorrelation
      .map((pair) => `${pair.a}/${pair.b} ${pair.all.toFixed(2)} (up ${num(pair.btcUp)} / down ${num(pair.btcDown)})`)
      .join(" · ");
    card.append(pairs);
  }
  if (payload.scan?.bestGuardedSharpe?.length) {
    card.append(el("h3", "", "Highest guarded Sharpe in the equal-weight monthly scan"));
    const best = el("p", "hint");
    best.textContent = payload.scan.bestGuardedSharpe
      .map((row) => `${row.symbols.join(" ")} Sharpe ${row.sharpe.toFixed(2)}, ${row.multiple.toFixed(2)}× vs hold ${row.holdMultiple.toFixed(2)}×`)
      .join(" · ");
    card.append(best);
  }
  host.append(card);
}

interface StudyStat {
  multiple: number;
  dragUsdt: number;
}
interface StudyFile {
  note: string;
  guard: string;
  fee_bps: number;
  slippage_bps: number;
  capital_usdt: number;
  drafts: Array<{
    name: string;
    symbols: string[];
    weights: number[];
    frequency: Frequency;
    start: string;
    end: string;
    plain: StudyStat;
    guarded: StudyStat;
    holdMultiple: number;
    btcMultiple: number | null;
  }>;
  scan?: {
    lowestCorrelation?: Array<{ a: string; b: string; all: number; btcUp: number | null; btcDown: number | null }>;
    bestGuardedSharpe?: Array<{ symbols: string[]; sharpe: number; multiple: number; holdMultiple: number }>;
  };
}

function coinInfo(symbol: string): CoinInfo | undefined {
  return manifest?.coins.find((coin) => coin.symbol === symbol);
}

function corrColor(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "#f2dfce";
  const clamped = Math.max(-1, Math.min(1, value));
  if (clamped >= 0) return mix("#fff1e5", "#990f3d", clamped);
  return mix("#fff1e5", "#0d7680", -clamped);
}

function mix(from: string, to: string, t: number): string {
  const a = hex(from);
  const b = hex(to);
  const c = a.map((channel, i) => Math.round(channel + (b[i] - channel) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function hex(value: string): [number, number, number] {
  const n = Number.parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function equityCsv(result: SimSuccess): string {
  const headers = [
    "time",
    "equity_usdt",
    "hold_usdt",
    "btc_price",
    "btc_hold_usdt",
    "usdt_cash",
    ...result.assets.flatMap((asset) => [`value_${asset.symbol}`, `qty_${asset.symbol}`]),
  ];
  const lines = [headers.join(",")];
  for (const point of result.points) {
    const cells = [
      new Date(point.t).toISOString(),
      point.equity.toFixed(4),
      point.hold.toFixed(4),
      point.btcPrice == null ? "" : point.btcPrice.toFixed(8),
      point.btc == null ? "" : point.btc.toFixed(4),
      point.usdt.toFixed(6),
    ];
    result.assets.forEach((_, index) => {
      cells.push((point.values[index] ?? 0).toFixed(4), (point.qty[index] ?? 0).toFixed(8));
    });
    lines.push(cells.join(","));
  }
  return lines.join("\n");
}

function tradesCsv(result: SimSuccess): string {
  const lines = ["time,side,symbol,qty,price,notional,cash,fee,trail_30d,sold_strength"];
  for (const event of result.events) {
    for (const trade of event.trades) {
      lines.push([
        new Date(trade.t).toISOString(),
        trade.side,
        trade.symbol,
        trade.qty,
        trade.price,
        trade.notional,
        trade.cash,
        trade.fee,
        trade.trail ?? "",
        event.soldStrengthToWeakness ? "yes" : "no",
      ].join(","));
    }
  }
  return lines.join("\n");
}

function downloadCsv(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = el("a") as HTMLAnchorElement;
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function labelFrequency(value: Frequency): string {
  if (value === "none") return "Never (hold)";
  if (value === "daily") return "Daily";
  if (value === "weekly") return "Weekly";
  if (value === "biweekly") return "Every 2 weeks";
  return "Monthly";
}

function row(tag: "td" | "th", cells: string[]): HTMLTableRowElement {
  const tr = el("tr");
  for (const cell of cells) tr.append(el(tag, "", cell));
  return tr;
}

function wrap(table: HTMLTableElement): HTMLElement {
  const scroller = el("div", "table-scroll");
  scroller.append(table);
  return scroller;
}

function field(label: string, control: HTMLElement): HTMLElement {
  return labeled(label, control);
}

function labeled(text: string, control: HTMLElement): HTMLElement {
  const wrapLabel = el("label", "field");
  wrapLabel.append(el("span", "label", text), control);
  return wrapLabel;
}

function input(type: string, value: string): HTMLInputElement {
  const node = el("input") as HTMLInputElement;
  node.type = type;
  node.value = value;
  return node;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

window.addEventListener("resize", () => lastDraw?.());
