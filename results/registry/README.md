# Validation registry

This directory is the versioned record of rebalance rules that were actually scored. Git history is the version control. A new result is a new commit that appends a ledger row. Old rows are not rewritten to make a later rule look better.

## What a row is

One rule, on one book, on one frozen test.

`results/registry/ledger.jsonl` has one JSON object per row. `VERSIONS.md` is the readable index, rebuilt from the ledger by `scripts/build_version_ledger.py`. The raw sample log is `results/alts-search-log.jsonl`. Per-window rows for the earlier four-book check stay in `results/validation.json`. The window draw is `results/windows-5000.json`.

## Two tests, not one

`calendar-6` uses the six named windows in `results/validation.json` (2023 through 2026). `windows-5000-full` uses 550 alt lists and 5,000 windows, half bitcoin-up and half bitcoin-down, lengths 90 to 540 days, seed 20261122, from 2022-03-01 to 2026-11-20. The sample is 51 of those lists and every 25th window. A rate from one test is not a rate from the other.

## Pass

Costs are 10,000 USDT, 10 bps fee, 5 bps slippage. A pass means final equity is more than 0.01 USDT ahead of both buy-and-hold and a plain rebalance to the entered weights. Windows are not dropped. No price from after the decision is used.

## What is still missing

Every row so far stores how often the rule finished ahead. None stores by how much. From the next scored version, a row also needs the median and mean gap versus hold and versus the plain rebalance, in USDT. A rule is not comparable on return size until those fields are filled.

## Champion

`alts/cash-200-50-50`, full pass, 62.9% beat-both. Spec is in that ledger row. Later sample losses do not replace it. A replacement needs its own full pass, and it has to be better on the balance of beat-both rate and return size, not on a single sample look.
