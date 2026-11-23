import type { IntelligentSpec } from "./types.ts";

export type BookKind = "btc-eth" | "alts-stable" | "btc-alts" | "alts";

export interface AlgoVariant {
  id: string;
  book: BookKind;
  label: string;
  rule: string;
  results: string;
  when: string;
  spec: IntelligentSpec;
}

const pair = {
  enabled: true,
  score: "absolute" as const,
  momentumDays: 30,
  trendDays: 50,
  leaderWeight: 0.8,
  defense: "equal" as const,
};

const cash: IntelligentSpec = {
  ...pair,
  regime: "cowen",
  riskOff: "cash",
  btcMaDays: 200,
  btcFastMaDays: 0,
  dominanceMaDays: 50,
  totalMaDays: 50,
};

/** Scored rules a user can still pick. The first in each book is the one the past test favored, not a hidden default. */
export const VARIANTS: AlgoVariant[] = [
  {
    id: "btc-eth-stay300-floor10",
    book: "btc-eth",
    label: "300-day bitcoin switch, 10% floor",
    rule: "Every 14 days. While bitcoin is above its 300-day average, the stronger of bitcoin and ether, measured over 30 days and only if it is also above its 50-day average, gets 80%. The other keeps 20%. While bitcoin is below its 300-day average, the book is left alone. Each coin keeps at least 10%, so ether cannot be sold out.",
    results: "From $10,000, 17 August 2017 through 20 November 2026, with a 0.10% fee and 0.05% slippage: $498,328, against $93,972 for holding and $122,467 for a plain rebalance. It ended with 7.62 BTC and 30.39 ETH. It beat holding on 7 of the 8 named stretches. The miss was the 2017 bull, $28,168 against $32,994. The 2018 bear finished at $3,837 against $1,431, and the 2020–21 bull at $325,516 against $258,447, with both coins still held.",
    when: "Use this for a bull or a bear when the book has to keep both coins. It is the best measured balance of dollars and a remaining ether stack. It is not a euphoria rule: nothing here detects a blow-off.",
    spec: { ...pair, regime: "btc-stay", regimeDays: 300, floorWeight: 0.1 },
  },
  {
    id: "btc-eth-stay300",
    book: "btc-eth",
    label: "300-day bitcoin switch, no floor",
    rule: "Every 14 days. Same 300-day switch and 80/20 tilt as the floored rule, but a coin may be sold down to zero.",
    results: "Same costs and span: $640,714, against $93,972 for holding and $122,467 for a plain rebalance. That is the highest finish. It ended with 10.87 BTC and no ether. It also missed only the 2017 bull ($28,391 against $32,994). The 2018 bear made $4,242 against $1,431 and held no ether. On a separate sample of 17 overlapping 3.5-year windows it beat both holding and a plain rebalance 17 times out of 17, and the median window still ended with no ether.",
    when: "Use this in a bitcoin uptrend when the dollar result matters more than keeping ether. Do not use it when ether has to survive a bear: the 2018 bear and the 2024–26 stretch both finished with no ether.",
    spec: { ...pair, regime: "btc-stay", regimeDays: 300 },
  },
  {
    id: "btc-eth-stay200",
    book: "btc-eth",
    label: "200-day bitcoin switch",
    rule: "Every 14 days. The 80/20 tilt runs only while bitcoin is above its 200-day average. Below that, the book is left alone. There is no floor, so a coin can be sold out.",
    results: "Same costs and span: $470,341, against $93,972 for holding. It ended with 7.98 BTC and no ether. It lost the 2017 bull and the 2019 stretch, and beat holding on the other named stretches. On the 17 overlapping 3.5-year windows it beat both benchmarks on 76.5%.",
    when: "This is the rule the app used before the longer history was scored. It is still available. The 300-day rules made more on that history. It is a weaker bear hold than the 10% floor, because it can sell all the ether.",
    spec: { ...pair, regime: "btc-stay", regimeDays: 200 },
  },
  {
    id: "btc-eth-band-floor10",
    book: "btc-eth",
    label: "Weekly band, 10% floor",
    rule: "Every 14 days. Bitcoin is treated as strong only when the last completed weekly close is above both the 20-week average and the 21-week exponential average. Ether gets the 80% tilt only when it is also up over 90 days in dollars and above its 90-day average against bitcoin. From 2022, a rise in the fixed-basket dominance over 180 days blocks that tilt. Below the band, a book that holds bitcoin stays in bitcoin and is not sold into USDT. Each coin keeps at least 10%.",
    results: "Same costs and span: $258,353, against $93,972 for holding, ending with 3.95 BTC and 15.76 ETH. It beat holding on 6 of the 8 named stretches. It tied holding in the 2017 bull and lost the 2020–21 bull, $233,235 against $258,447. A slower variant, a 20% floor with a 140-day ether/bitcoin average and a 90-day dominance window, finished lower still, at $182,246, and also lost 2020–21.",
    when: "Use this when you want the book to stay with bitcoin unless ether has been leading for months. It kept both coins through the bears. It is the wrong rule for a strong ether uptrend: it sat out most of 2020–21. Euphoria is not scored. This band does step back when dominance is not falling, so a late alt frenzy is where it will lag.",
    spec: {
      ...pair,
      regime: "cowen-band",
      bandWeeks: 20,
      bandEmaWeeks: 21,
      dominanceTrendDays: 180,
      pairMaDays: 90,
      floorWeight: 0.1,
    },
  },
  {
    id: "btc-alts-stay200",
    book: "btc-alts",
    label: "200-day bitcoin switch",
    rule: "Every 14 days, for bitcoin plus one or more altcoins, not the bitcoin-and-ether pair. While bitcoin is above its 200-day average, the strongest selected coin above its 50-day average, by its own 30-day dollar gain, gets 80%. The rest is split across the other selected coins. While bitcoin is below that average, the book is left alone. Bitcoin is not added and is not sold just because the switch is off.",
    results: "448 saved books, four stretches (the 2022 bear, the 2023–24 bull, 2024–26, and November 2021 through 20 November 2026): 1,792 runs, none skipped. Beat both holding and a plain rebalance on 56.0%. Bull stretches 70.4%. The 2022 bear 27.2%. Median gap versus holding on the long stretch was +$1,365.",
    when: "Use this in an uptrend. Do not expect it to rescue the book in a bear: with bitcoin under the average it holds the alts through the drop, and the bear pass rate was 27%. No euphoria test exists for this book.",
    spec: { ...pair, regime: "btc-stay", regimeDays: 200 },
  },
  {
    id: "btc-alts-stay300",
    book: "btc-alts",
    label: "300-day bitcoin switch",
    rule: "Every 14 days. The same tilt, with the switch at bitcoin's 300-day average instead of 200.",
    results: "Same 1,792 runs. Beat both benchmarks on 46.3%. Bull stretches 63.4%. The 2022 bear 15.4%. Median gap versus holding on the long stretch was +$396, less than the 200-day rule.",
    when: "This is the runner-up. The longer average that won on bitcoin-and-ether lost here, in the bull stretches and in the bear. Prefer the 200-day switch unless you specifically want the same 300-day gate as the pair.",
    spec: { ...pair, regime: "btc-stay", regimeDays: 300 },
  },
  {
    id: "alts-stable-stay200",
    book: "alts-stable",
    label: "200-day bitcoin switch, weak coins to USDT",
    rule: "Every 14 days, for USDT plus altcoins, with no bitcoin in the book. While bitcoin is above its 200-day average, a selected coin below its 50-day average, or without a positive 30-day dollar gain, is sold into USDT. A coin that still qualifies can receive the 80% leader weight. While bitcoin is below its 200-day average, the book is left alone.",
    results: "448 saved books, the same four stretches: 1,594 runs, 198 skipped because the coin was not listed yet. Beat both benchmarks on 73.0%. Bull stretches 57.5%. The 2022 bear 88.8%. Median gap versus holding on the long stretch was +$6,159.",
    when: "Use this in a bear and in a mixed stretch. The bear result is the reason to keep it. In a broad uptrend it is only a modest edge over holding. It is not a euphoria rule.",
    spec: { ...pair, regime: "btc-stay", regimeDays: 200 },
  },
  {
    id: "alts-stable-stay300",
    book: "alts-stable",
    label: "300-day bitcoin switch, weak coins to USDT",
    rule: "Every 14 days. The same USDT rule, with the switch at bitcoin's 300-day average.",
    results: "Same runs: beat both on 60.3%. Bull stretches 58.3%, about the same as the 200-day rule. The 2022 bear fell to 28.6%. Median gap versus holding on the long stretch was +$5,642.",
    when: "Runner-up. The bull result is close to the 200-day rule, and the bear result is much worse. Use the 200-day switch unless you have a reason to wait longer before protecting the book.",
    spec: { ...pair, regime: "btc-stay", regimeDays: 300 },
  },
  {
    id: "alts-cash",
    book: "alts",
    label: "Cash when a filter fails",
    rule: "Every 14 days, for altcoins only. The 80% leader weight is used only while bitcoin is above its 200-day average, dominance is below its 50-day average, and the stored total is above its 50-day average. Otherwise the book is sold into USDT. Dominance and total are the stored basket, not a live feed. The day counts below are editable. The measured results use 200, 50, and 50.",
    results: "On the four long stretches, 550 books gave 2,080 runs, 120 skipped: beat both benchmarks on 70.2%. Bull stretches 52.3%. The 2022 bear 84.4%. Median gap versus holding on November 2021 through 20 November 2026 was +$8,245. The separate full test, 5,000 windows of 90 to 540 days from March 2022 through 20 November 2026, was 2,623,234 runs: beat both on 62.9%, 40.1% when bitcoin rose over the window, 85.7% when it fell.",
    when: "Use this in a bear. That is where it earned its place. In an uptrend it often sits in cash while the alts rise, which is why the bitcoin-up rate stays near 40% on the large test. A euphoria rally, alts rising while dominance also rises, is exactly the case it steps out of. No tested alternative kept the bear result and caught that rally.",
    spec: cash,
  },
  {
    id: "alts-stay",
    book: "alts",
    label: "Leave the book alone when a filter fails",
    rule: "Every 14 days. The same three filters and the same leader tilt. When a filter fails, nothing is sold. The current mix stays.",
    results: "Same four stretches and 2,080 runs: beat both benchmarks on 26.9%. Bull stretches 40.8%. The 2022 bear 9.6%. Median gap versus holding on the long stretch was -$584.",
    when: "Runner-up, and a weak one. Use it only if you refuse to hold USDT. It lost to holding on the long stretch and almost never won the bear. It is not the uptrend or euphoria fix: the bull rate was worse than cash.",
    spec: { ...cash, riskOff: "stay" },
  },
  {
    id: "alts-mix",
    book: "alts",
    label: "Return to your weights when a filter fails",
    rule: "Every 14 days. The same three filters and the same leader tilt. When a filter fails, the book trades back to the weights you typed.",
    results: "Same 2,080 runs: beat both on 25.8%. Bull stretches 41.1%. The 2022 bear 9.8%. Median gap versus holding on the long stretch was -$432.",
    when: "Also a runner-up that lost money against holding. Prefer cash in a bear. Prefer neither of these two in an uptrend. Euphoria is not solved by returning to equal weights.",
    spec: { ...cash, riskOff: "mix" },
  },
];

export function variantsFor(book: BookKind): AlgoVariant[] {
  return VARIANTS.filter((variant) => variant.book === book);
}

export function variantById(id: string): AlgoVariant | null {
  return VARIANTS.find((variant) => variant.id === id) ?? null;
}

/** Older saved books stored only the book kind. That meant the 200-day switch, or cash for alts. */
export function legacyVariant(book: { algo?: BookKind; variant?: string; riskOff?: string }): string | null {
  if (book.variant && variantById(book.variant)) return book.variant;
  if (book.algo === "alts") {
    if (book.riskOff === "stay") return "alts-stay";
    if (book.riskOff === "mix") return "alts-mix";
    return "alts-cash";
  }
  if (book.algo === "btc-eth" || book.algo === "btc-alts" || book.algo === "alts-stable") return `${book.algo}-stay200`;
  return null;
}
