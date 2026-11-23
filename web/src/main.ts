import { correlationMatrix } from "@engine/correlation.ts";
import { guardsAreActive, simulate, simulateNaive } from "@engine/simulate.ts";
import type { CandleSeries, Frequency, SimInput, SimSuccess } from "@engine/types.ts";
import { legacyVariant, variantById, variantsFor, type BookKind } from "@engine/variants.ts";
import { renderLineChart, renderStack, type ChartLine, type ValueScale } from "./chart.ts";
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
const PALETTE = ["#2196f3", "#ff5656", "#ff9800", "#00cf0a", "#9c27b0", "#14b8a6", "#0069d9", "#d14343", "#65748b", "#ffb020"];

function bookKind(symbols: string[]): BookKind | null {
  const set = new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean));
  const hasBtc = set.has("BTC");
  const hasEth = set.has("ETH");
  const hasUsdt = set.has("USDT");
  const alts = [...set].filter((symbol) => symbol !== "BTC" && symbol !== "USDT");
  if (set.size === 2 && hasBtc && hasEth) return "btc-eth";
  if (hasUsdt && !hasBtc && alts.length >= 1 && set.size === alts.length + 1) return "alts-stable";
  if (hasBtc && !hasUsdt && alts.length >= 1 && !(set.size === 2 && hasEth)) return "btc-alts";
  if (!hasBtc && !hasUsdt && alts.length >= 2) return "alts";
  return null;
}

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
const FREQUENCIES: Frequency[] = ["none", "daily", "weekly", "biweekly", "monthly", "custom"];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const BOOKS_KEY = "firehorse.portfolio-books.v1";

interface SavedBook {
  id: string;
  name: string;
  holdings: Holding[];
  frequency: Frequency;
  weekday: number;
  monthDay: number;
  capital: string;
  start: string;
  end: string;
  fee: string;
  slip: string;
  everyDays?: number;
  algo?: BookKind;
  variant?: string;
  intelligent?: boolean;
  momentumDays?: string;
  trendDays?: string;
  btcMaDays?: string;
  btcFastMaDays?: string;
  dominanceMaDays?: string;
  totalMaDays?: string;
  leaderWeight?: string;
  riskOff?: "stay" | "mix" | "cash";
  leaderPct?: string;
  score?: "absolute" | "vsbtc";
  defense?: "stay" | "equal" | "btc";
  protect?: boolean;
}

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing app root");

let manifest: Manifest | null = null;
let holdings: Holding[] = [];
let lastDraw: (() => void) | null = null;
let scaleMode: ValueScale = "usd";
let loadSaved: ((book: SavedBook) => void) | null = null;

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

  const booksHost = el("div", "books");
  const bookName = input("text", "");
  bookName.placeholder = "Name this book";
  bookName.maxLength = 60;
  const saveBook = el("button", "btn ghost");
  saveBook.type = "button";
  saveBook.textContent = "Save";
  const bookSave = el("div", "book-save");
  bookSave.append(bookName, saveBook);
  form.append(
    field(
      "Your books",
      bookSave,
      "Nothing is saved until you save it. A book stores this mix, the weights, the calendar, the fees, and whether winner protection is on. Books stay in this browser only. There are no built-in books.",
    ),
    booksHost,
  );

  const search = el("input") as HTMLInputElement;
  search.placeholder = "Add a coin — BTC, TAO, or TON";
  search.autocomplete = "off";
  const suggest = el("div", "suggest");
  search.addEventListener("input", () => fillSuggest(suggest, search.value));
  form.append(
    field(
      "Coins",
      search,
      "Search the stored Binance USDT markets. Add 1 to 10 coins. USDT is cash at a price of 1 and can be a sleeve. TON selects GRAM, which is Toncoin after Binance renamed the market.",
    ),
    suggest,
  );

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
  const weekday = el("select") as HTMLSelectElement;
  WEEKDAYS.forEach((name, index) => {
    const option = el("option");
    option.value = String(index);
    option.textContent = name;
    weekday.append(option);
  });
  weekday.value = "1";
  const monthDay = input("number", "1");
  monthDay.min = "1";
  monthDay.max = "31";
  monthDay.step = "1";
  const everyDays = input("number", "14");
  everyDays.min = "1";
  everyDays.max = "365";
  everyDays.step = "1";
  const fee = input("number", "10");
  fee.min = "0";
  fee.step = "1";
  const slip = input("number", "5");
  slip.min = "0";
  slip.step = "1";
  const weekdayField = labeled(
    "Day of week, UTC",
    weekday,
    "Weekly and every-two-weeks runs trade on this UTC weekday, on the first 4-hour close of that day. Pick the same weekday you will actually trade.",
  );
  const monthField = labeled(
    "Day of month, UTC",
    monthDay,
    "Monthly runs trade on this UTC day. 1 is the first of the month. If the month is shorter than the day you pick, the run uses the last day of that month.",
  );
  const daysField = labeled(
    "Every, days",
    everyDays,
    "How many UTC days between checks. 14 looks again on the first 4-hour close 14 days after the previous check. 1 is the same as daily.",
  );
  const syncSchedule = () => {
    const value = frequency.value;
    weekdayField.hidden = value !== "weekly" && value !== "biweekly";
    monthField.hidden = value !== "monthly";
    daysField.hidden = value !== "custom";
  };
  frequency.addEventListener("change", syncSchedule);
  syncSchedule();

  const dates = el("div", "field row");
  dates.append(
    labeled("Start, UTC", start, "First day of the test. Coins that already trade are bought that day. A coin with no price yet stays as USDT until it lists, and the chart still starts here."),
    labeled("End, UTC", end, "Last day included. The last 4-hour close on or before the end of this UTC day is the final mark."),
  );
  const costs = el("div", "field row");
  costs.append(
    labeled("Fee, bps", fee, "Exchange fee in basis points. 10 bps is 0.10% of the coin value, charged on the way out and on the way in. USDT transfers are free. 100 bps = 1%."),
    labeled("Slippage, bps", slip, "Extra haircut, in basis points, for crossing the spread and moving the price. It is added to the fee. 5 bps is 0.05%."),
  );
  form.append(
    field("Starting capital", capital, "USDT you start with. Weights are applied to this amount on the first bar."),
    dates,
    field(
      "How often to look",
      frequency,
      "Plain rebalance is the default. On each scheduled check the book trades back to your weights. Daily uses the first 4-hour bar of each UTC day. Weekly and every two weeks use the weekday below. Monthly uses the day of the month below. Every N days uses the number below. Never means buy once and hold.",
    ),
    weekdayField,
    monthField,
    daysField,
    costs,
  );

  let pickedVariant: string | null = null;
  const variantHost = el("div", "variants");
  const guard = el("div", "guard");
  const missingAlgo = el("p", "hint", "Add a book that matches one group: bitcoin and ether, bitcoin plus altcoins, USDT plus altcoins, or altcoins only.");
  missingAlgo.hidden = true;
  const guardBody = el("div", "guard-body");
  guardBody.hidden = true;
  const algoNote = el("p", "hint", "The past results used bitcoin 200, dominance 50, total 50, momentum 30, coin average 50, and leader 80. Change a number and the run is no longer that test.");
  const btcMaDays = input("number", "200");
  const btcFastMaDays = input("number", "0");
  const dominanceMaDays = input("number", "50");
  const totalMaDays = input("number", "50");
  const momentumDays = input("number", "30");
  const trendDays = input("number", "50");
  const leaderWeight = input("number", "80");
  for (const field of [btcMaDays, btcFastMaDays, dominanceMaDays, totalMaDays, momentumDays, trendDays]) {
    field.min = "0";
    field.max = "400";
    field.step = "1";
  }
  leaderWeight.min = "5";
  leaderWeight.max = "100";
  leaderWeight.step = "1";
  const riskOff = el("select") as HTMLSelectElement;
  for (const [value, label] of [
    ["stay", "Leave the book alone"],
    ["mix", "Return to your weights"],
    ["cash", "Sell into USDT"],
  ] as const) {
    const option = el("option");
    option.value = value;
    option.textContent = label;
    riskOff.append(option);
  }
  riskOff.value = "cash";
  const cowenFields = el("div", "field");
  cowenFields.append(
    labeled("Bitcoin average, days", btcMaDays, "Tilt only while bitcoin closes above this average. 140 is about 20 weeks. 0 turns this off."),
    labeled("Bitcoin fast average, days", btcFastMaDays, "A second bitcoin average. Both must pass. 0 turns this off."),
    labeled("Dominance average, days", dominanceMaDays, "Tilt only while bitcoin's share of the stored basket is below this average. That is the alt-season side. 0 turns this off."),
    labeled("Total market cap average, days", totalMaDays, "Tilt only while the stored basket's total value is above this average. 0 turns this off."),
    labeled("Momentum, days", momentumDays, "How far back the leader's return is measured."),
    labeled("Coin average, days", trendDays, "A coin can lead only while its price is above this average."),
    labeled("Leader weight, percent", leaderWeight, "Share of the book given to the leader while every filter passes. The rest stays in the other selected coins."),
  );
  cowenFields.hidden = true;
  guardBody.append(algoNote, cowenFields);
  const factors = () => ({ btcMaDays, btcFastMaDays, dominanceMaDays, totalMaDays, momentumDays, trendDays, leaderWeight, riskOff });
  const selectedVariant = () => (pickedVariant ? variantById(pickedVariant) : null);
  const applyAltsKnobs = (id: string) => {
    const variant = variantById(id);
    if (!variant || variant.book !== "alts") return;
    const spec = variant.spec;
    btcMaDays.value = String(spec.btcMaDays ?? 200);
    btcFastMaDays.value = String(spec.btcFastMaDays ?? 0);
    dominanceMaDays.value = String(spec.dominanceMaDays ?? 50);
    totalMaDays.value = String(spec.totalMaDays ?? 50);
    momentumDays.value = String(spec.momentumDays);
    trendDays.value = String(spec.trendDays);
    leaderWeight.value = String(Math.round(spec.leaderWeight * 100));
    riskOff.value = spec.riskOff === "mix" || spec.riskOff === "stay" ? spec.riskOff : "cash";
  };
  const syncAlgos = () => {
    const kind = bookKind(holdings.map((row) => row.symbol));
    missingAlgo.hidden = kind != null;
    if (pickedVariant && variantById(pickedVariant)?.book !== kind) pickedVariant = null;
    variantHost.replaceChildren();
    if (kind) {
      variantHost.append(el("p", "hint", "Plain rebalance stays on until you pick a rule. Each rule below is available because the past tests did not agree."));
      const off = el("label", "variant");
      const offBox = el("input") as HTMLInputElement;
      offBox.type = "radio";
      offBox.name = "algo-variant";
      offBox.checked = pickedVariant == null;
      offBox.addEventListener("change", () => {
        if (!offBox.checked) return;
        pickedVariant = null;
        syncAlgos();
      });
      const offName = el("span", "name", "Off");
      const offText = el("p", "", "No intelligent rule. On each scheduled check the book trades back to the weights you typed.");
      off.append(offBox, offName, offText);
      variantHost.append(off);
      for (const variant of variantsFor(kind)) {
        const row = el("label", "variant");
        const box = el("input") as HTMLInputElement;
        box.type = "radio";
        box.name = "algo-variant";
        box.value = variant.id;
        box.checked = pickedVariant === variant.id;
        box.addEventListener("change", () => {
          if (!box.checked) return;
          pickedVariant = variant.id;
          frequency.value = "custom";
          everyDays.value = "14";
          syncSchedule();
          applyAltsKnobs(variant.id);
          syncAlgos();
        });
        row.append(box, el("span", "name", variant.label), el("p", "", variant.rule), el("p", "", variant.results), el("p", "", variant.when));
        variantHost.append(row);
      }
    }
    const selected = selectedVariant();
    guardBody.hidden = selected?.book !== "alts";
    cowenFields.hidden = selected?.book !== "alts";
  };
  const actions = el("div", "actions");
  const runBtn = el("button", "btn primary");
  runBtn.type = "submit";
  runBtn.textContent = "Run";
  actions.append(runBtn);
  guard.append(missingAlgo, variantHost, guardBody, actions);
  syncAlgos();
  form.append(guard);

  const results = el("div", "results");
  results.id = "results";
  results.append(el("p", "muted", "Add one or more coins, set the weights and the calendar, then run. The default run is a plain rebalance. Nothing is loaded for you."));
  layout.append(form, results);
  ui.sim.replaceChildren(layout);

  function readBooks(): SavedBook[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(BOOKS_KEY) ?? "[]") as SavedBook[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  function writeBooks(books: SavedBook[]): void {
    localStorage.setItem(BOOKS_KEY, JSON.stringify(books));
  }
  function paintBooks(): void {
    booksHost.replaceChildren();
    const books = readBooks();
    if (books.length === 0) {
      booksHost.append(el("p", "empty-books", "No saved books yet."));
      return;
    }
    for (const book of books) {
      const row = el("div", "book-row");
      const open = el("button");
      open.type = "button";
      open.textContent = "Load";
      open.addEventListener("click", () => loadSaved?.(book));
      const remove = el("button");
      remove.type = "button";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => {
        writeBooks(readBooks().filter((item) => item.id !== book.id));
        paintBooks();
      });
      row.append(el("span", "", book.name), open, remove);
      booksHost.append(row);
    }
  }
  saveBook.addEventListener("click", () => {
    const name = bookName.value.trim();
    if (!name) {
      bookName.focus();
      return;
    }
    if (holdings.length < 1) return;
    const book: SavedBook = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      holdings: holdings.map((row) => ({ ...row })),
      frequency: frequency.value as Frequency,
      weekday: Number(weekday.value),
      monthDay: Number(monthDay.value),
      capital: capital.value,
      start: start.value,
      end: end.value,
      fee: fee.value,
      slip: slip.value,
      everyDays: Number(everyDays.value),
      algo: selectedVariant()?.book,
      variant: selectedVariant()?.id,
      btcMaDays: btcMaDays.value,
      btcFastMaDays: btcFastMaDays.value,
      dominanceMaDays: dominanceMaDays.value,
      totalMaDays: totalMaDays.value,
      momentumDays: momentumDays.value,
      trendDays: trendDays.value,
      leaderWeight: leaderWeight.value,
      riskOff: riskOff.value === "mix" || riskOff.value === "cash" ? riskOff.value : "stay",
    };
    writeBooks([book, ...readBooks().filter((item) => item.name !== name)]);
    bookName.value = "";
    paintBooks();
  });
  paintBooks();

  loadSaved = (book) => {
    holdings = book.holdings.map((row) => ({ ...row }));
    frequency.value = book.frequency;
    weekday.value = String(book.weekday ?? 1);
    monthDay.value = String(book.monthDay ?? 1);
    capital.value = book.capital;
    start.value = book.start;
    end.value = book.end;
    fee.value = book.fee;
    slip.value = book.slip;
    everyDays.value = String(book.everyDays ?? 14);
    btcMaDays.value = book.btcMaDays ?? "200";
    btcFastMaDays.value = book.btcFastMaDays ?? "0";
    dominanceMaDays.value = book.dominanceMaDays ?? "50";
    totalMaDays.value = book.totalMaDays ?? "50";
    momentumDays.value = book.momentumDays ?? "30";
    trendDays.value = book.trendDays ?? "50";
    leaderWeight.value = book.leaderWeight ?? "80";
    riskOff.value = book.riskOff === "mix" || book.riskOff === "stay" ? book.riskOff : "cash";
    syncSchedule();
    drawHoldings();
    const kind = bookKind(holdings.map((row) => row.symbol));
    const restored = legacyVariant(book);
    pickedVariant = restored && variantById(restored)?.book === kind ? restored : null;
    if (pickedVariant?.startsWith("alts-")) applyAltsKnobs(pickedVariant);
    syncAlgos();
    void run();
  };

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
      box.title = "Never sell this coin on a plain rebalance. Intelligent rebalancing follows the leader rule instead.";
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
    syncAlgos();
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

  async function run(): Promise<void> {
    if (!manifest) return;
    results.replaceChildren(el("p", "muted", "Running…"));
    const built = buildInput(capital, start, end, frequency, weekday, monthDay, everyDays, fee, slip, pickedVariant, factors());
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

}

function dayField(field: HTMLInputElement, fallback: number): number {
  const value = Math.round(Number(field.value));
  return Number.isFinite(value) ? value : fallback;
}

function algoSpec(
  variantId: string | null,
  factors?: {
    btcMaDays: HTMLInputElement;
    btcFastMaDays: HTMLInputElement;
    dominanceMaDays: HTMLInputElement;
    totalMaDays: HTMLInputElement;
    momentumDays: HTMLInputElement;
    trendDays: HTMLInputElement;
    leaderWeight: HTMLInputElement;
    riskOff: HTMLSelectElement;
  },
): SimInput["intelligent"] {
  const variant = variantId ? variantById(variantId) : null;
  if (!variant) return undefined;
  if (variant.book !== "alts" || !factors) return variant.spec;
  const leader = dayField(factors.leaderWeight, 80) / 100;
  const riskOff = factors.riskOff.value === "mix" || factors.riskOff.value === "cash" ? factors.riskOff.value : "stay";
  return {
    ...variant.spec,
    momentumDays: Math.max(2, dayField(factors.momentumDays, 30)),
    trendDays: Math.max(2, dayField(factors.trendDays, 50)),
    leaderWeight: Math.min(1, Math.max(0.05, leader)),
    btcMaDays: Math.max(0, dayField(factors.btcMaDays, 200)),
    btcFastMaDays: Math.max(0, dayField(factors.btcFastMaDays, 0)),
    dominanceMaDays: Math.max(0, dayField(factors.dominanceMaDays, 50)),
    totalMaDays: Math.max(0, dayField(factors.totalMaDays, 50)),
    riskOff,
  };
}

function buildInput(
  capital: HTMLInputElement,
  start: HTMLInputElement,
  end: HTMLInputElement,
  frequency: HTMLSelectElement,
  weekday: HTMLSelectElement,
  monthDay: HTMLInputElement,
  everyDays: HTMLInputElement,
  fee: HTMLInputElement,
  slip: HTMLInputElement,
  variantId: string | null,
  factors?: {
    btcMaDays: HTMLInputElement;
    btcFastMaDays: HTMLInputElement;
    dominanceMaDays: HTMLInputElement;
    totalMaDays: HTMLInputElement;
    momentumDays: HTMLInputElement;
    trendDays: HTMLInputElement;
    leaderWeight: HTMLInputElement;
    riskOff: HTMLSelectElement;
  },
): { symbols: string[]; input: Omit<SimInput, "series" | "btc"> } | string {
  if (holdings.length < 1 || holdings.length > 10) return "Add between 1 and 10 coins, then run.";
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
      weekday: Number(weekday.value),
      monthDay: Number(monthDay.value),
      everyDays: Number(everyDays.value),
      band: 0,
      fraction: 1,
      trend: { enabled: false, smaDays: 50 },
      blockedBuyPolicy: "keep_winners",
      intelligent: algoSpec(variantId, factors),
    },
  };
}

async function loadBook(symbols: string[]): Promise<{ series: Record<string, CandleSeries>; btc: CandleSeries | null }> {
  const needed = new Set(symbols.filter((symbol) => symbol !== "USDT"));
  needed.add("BTC");
  const series: Record<string, CandleSeries> = {};
  await Promise.all([
    ...[...needed].map(async (symbol) => {
      const info = coinInfo(symbol);
      if (!info) throw new Error(`${symbol} is not in the downloaded universe.`);
      series[symbol] = await loadCandles(`${BASE}${info.path}?v=${manifest?.generated_at ?? "1"}`, symbol);
    }),
    ...(["BTCD", "TOTAL"] as const).map(async (symbol) => {
      series[symbol] = await loadCandles(`${BASE}data/candles/${symbol}.csv.gz?v=${manifest?.generated_at ?? "1"}`, symbol);
    }),
  ]);
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
  const chartHead = el("div", "chart-head");
  const chartTitle = el("div");
  chartTitle.append(el("h2", "", "Value over time"));
  const scaleToggle = el("div", "scale-toggle");
  const usdBtn = el("button");
  usdBtn.type = "button";
  usdBtn.textContent = "$";
  const pctBtn = el("button");
  pctBtn.type = "button";
  pctBtn.textContent = "%";
  scaleToggle.append(usdBtn, pctBtn, infoControl(
    "Dollar shows USDT value. Portfolio and coin lines use the right axis. Bitcoin's price uses the left axis, so a high BTC price does not flatten the book. Percent uses TradingView's percent scale: each line is the change from its own first visible point, and the axis updates as you scroll or zoom. Drag to pan, scroll to zoom, double-click the chart to reset.",
  ));
  chartHead.append(chartTitle, scaleToggle);
  chartCard.append(chartHead);
  const chart = el("div", "chart");
  const legend = el("div", "legend");
  chartCard.append(chart, legend);
  host.append(chartCard);

  const weightCard = el("div", "chart-card");
  weightCard.append(el("h2", "", "Weights"));
  const weights = el("div", "chart stack-chart");
  weightCard.append(weights);
  host.append(weightCard);

  const times = result.points.map((point) => point.t);
  const money = (value: number) => usdt(value);
  const btcLabel = (value: number) => `${quote(value)} USDT`;
  const specs: ChartSpec[] = [
    {
      id: "equity",
      name: "Portfolio",
      color: "#0069d9",
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
      on: false,
      values: result.points.map((point) => point.values[index] ?? null),
      label: money,
    });
  });
  if (result.points.some((point) => point.usdt > 1)) {
    specs.push({
      id: "cash",
      name: "USDT cash",
      color: "#65748b",
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
    on: true,
    values: result.points.map((point) => point.hold),
    label: money,
  });
  if (naive) {
    const naiveAt = new Map(naive.points.map((point) => [point.t, point.equity]));
    specs.push({
      id: "unguarded",
      name: "Plain",
      color: "#ff9800",
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
      color: "#121828",
      dash: "5 3",
      width: 1.8,
      axis: "right",
      on: false,
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
    const color = el("input") as HTMLInputElement;
    color.type = "color";
    color.value = spec.color;
    color.title = `Color for ${spec.name}`;
    color.addEventListener("input", () => {
      spec.color = color.value;
      swatch.style.background = color.value;
      paint();
    });
    item.append(box, color, swatch, document.createTextNode(spec.name));
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
    usdBtn.classList.toggle("on", scaleMode === "usd");
    pctBtn.classList.toggle("on", scaleMode === "pct");
    renderLineChart(chart, times, lines, { left: "USDT", right: "BTC price" }, {
      scale: scaleMode,
      fromMs: result.startMs,
      toMs: result.endMs,
    });
    const stride = Math.max(1, Math.floor(result.points.length / 300));
    const sample = result.points.filter((_, index) => index % stride === 0 || index === result.points.length - 1);
    const stack = result.assets.map((asset, index) => ({
      name: asset.symbol,
      color: PALETTE[index % PALETTE.length],
      values: sample.map((point) => point.weights[index] ?? 0),
    }));
    const residual = sample.map((point) => Math.max(0, 1 - point.weights.reduce((sum, value) => sum + value, 0)));
    if (residual.some((value) => value > 0.01)) {
      stack.push({ name: "USDT", color: "#c5cedd", values: residual });
    }
    renderStack(weights, sample.map((point) => point.t), stack);
  };
  usdBtn.addEventListener("click", () => {
    scaleMode = "usd";
    paint();
  });
  pctBtn.addEventListener("click", () => {
    scaleMode = "pct";
    paint();
  });
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
      `A plain rebalance on the same clock finished at ${usdt(naive.summary.finalEquity)}. This run differs by ${usdt(delta)}.`,
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
      cell.style.color = value != null && Math.abs(value) > 0.55 ? "#ffffff" : "#121828";
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

function coinInfo(symbol: string): CoinInfo | undefined {
  return manifest?.coins.find((coin) => coin.symbol === symbol);
}

function corrColor(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "#f3f4f6";
  const clamped = Math.max(-1, Math.min(1, value));
  if (clamped >= 0) return mix("#f9fafc", "#0069d9", clamped);
  return mix("#f9fafc", "#14b8a6", -clamped);
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
  if (value === "custom") return "Every N days";
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

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return labeled(label, control, hint);
}

function labeled(text: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrapLabel = el("label", "field");
  const head = el("span", "label-line");
  head.append(el("span", "label", text));
  if (hint) head.append(infoControl(hint));
  wrapLabel.append(head, control);
  return wrapLabel;
}

let openTip: { anchor: HTMLElement; pop: HTMLElement } | null = null;

function infoControl(text: string): HTMLElement {
  const wrap = el("span", "info-wrap");
  const button = el("button", "info");
  button.type = "button";
  button.textContent = "i";
  button.setAttribute("aria-label", "About this setting");
  const pop = el("div", "pop");
  pop.hidden = true;
  pop.textContent = text;
  pop.setAttribute("role", "tooltip");
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const opening = pop.hidden;
    closeTips();
    if (!opening) return;
    document.body.append(pop);
    pop.hidden = false;
    openTip = { anchor: button, pop };
    placeTip(button, pop);
  });
  wrap.append(button);
  return wrap;
}

function placeTip(anchor: HTMLElement, pop: HTMLElement): void {
  const margin = 8;
  const width = Math.min(440, window.innerWidth - margin * 2);
  pop.style.width = `${width}px`;
  const rect = anchor.getBoundingClientRect();
  const box = pop.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 8;
  if (left + box.width > window.innerWidth - margin) left = window.innerWidth - margin - box.width;
  if (left < margin) left = margin;
  if (top + box.height > window.innerHeight - margin) {
    const above = rect.top - 8 - box.height;
    top = above >= margin ? above : margin;
  }
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function closeTips(): void {
  document.querySelectorAll<HTMLElement>(".pop").forEach((item) => {
    item.hidden = true;
  });
  openTip = null;
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest(".pop, .info")) return;
  closeTips();
});
window.addEventListener("resize", () => {
  if (openTip && !openTip.pop.hidden) placeTip(openTip.anchor, openTip.pop);
});
window.addEventListener("scroll", () => {
  if (openTip && !openTip.pop.hidden) placeTip(openTip.anchor, openTip.pop);
}, true);

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
