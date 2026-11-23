# Validation registry

This directory is the versioned record of rebalance rules that were actually scored. Git history is the version control. A new result is a new commit that appends a ledger row. Old rows are not rewritten to make a later rule look better.

## What a row is

One rule, on one book, on one frozen test.

`results/registry/ledger.jsonl` has one JSON object per row. `VERSIONS.md` is the readable index, rebuilt from the ledger by `scripts/build_version_ledger.py`. The raw sample log is `results/alts-search-log.jsonl`. Per-window rows for the earlier four-book check stay in `results/validation.json`. The window draw is `results/windows-5000.json`.

## Two tests, not one

`calendar-6` uses the six named windows in `results/validation.json` (2023 through 2026). `windows-5000-full` uses 550 alt lists and 5,000 windows, half bitcoin-up and half bitcoin-down, lengths 90 to 540 days, seed 20261122, from 2022-03-01 to 2026-11-20. The sample is 51 of those lists and every 25th window. A rate from one test is not a rate from the other.

## Pass

Costs are 10,000 USDT, 10 bps fee, 5 bps slippage. A pass means final equity is more than 0.01 USDT ahead of both buy-and-hold and a plain rebalance to the entered weights. Windows are not dropped. No price from after the decision is used.

## Return size

Rows from `calendar-6` and `windows-5000` store how often a book finished ahead. They do not store by how much. Rows from `named-8`, `named-4`, and `overlap-3.5y` store the dollar gap. Do not treat a rate from one scope as a rate from another.

## Defaults

A new screen starts with no coins and with every intelligent rule off. Plain rebalance is the run until the user picks a rule. The defaults below are which rule the tests support once that switch is turned on. They are not applied by themselves.

Bitcoin and ether: `btc-eth/stay300-floor10`. It finished the full span at 498,328 against 93,972 for holding, with both coins left, and it beat holding on 7 of the 8 named stretches. The no-floor 300-day rule finished higher, at 640,714, and sold all the ether, so it is logged and selectable but not the default.

Bitcoin plus altcoins: `btc-alts/stay200`. USDT plus altcoins: `alts-stable/stay200`. Altcoins only: `alts/cash-200-50-50`, the full-pass champion below.

## Not scored

The candles stop on 2026-11-20. December 2026 through November 2029 has no test. The 75% alt beat-both target was retired. No later sample beat the cash champion on both rate and return size, so the 2,623,234-window pass was not replaced.

## Champion

`alts/cash-200-50-50`, full pass, 62.9% beat-both. Spec is in that ledger row. Later sample losses do not replace it. A replacement needs its own full pass, and it has to be better on the balance of beat-both rate and return size, not on a single sample look.
