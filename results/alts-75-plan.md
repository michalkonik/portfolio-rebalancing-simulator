# Alts rule: search plan for a 75% beat-both rate

This file is the log of the search as it was run. On 2026-11-22 the owner rejected a rule that never loses to holding if that would give up large gains. The target from here is the best balance of two things: the share of tests that beat both hold and a plain rebalance, and the size of those returns. The 75% line below was the stop rule for this search, not that later target. The versioned record is `results/registry/`.

## Score

A test passes only when the intelligent book finishes more than 0.01 USDT ahead of both buy-and-hold and a plain rebalance to the entered weights. Same costs as the UI: 10,000 USDT, 10 bps fee, 5 bps slippage, check every 14 days.

The window set is `results/windows-5000.json`: 2,500 bitcoin-up and 2,500 bitcoin-down windows, lengths 90, 120, 180, 270, 365, and 540 days, seed 20261122, between 2022-03-01 and 2026-11-20. Books are the alt lists in `rebalance-portfolios.json` (no bitcoin, no USDT).

The fast loop uses 51 books (every 11th list) and every 25th window (200 windows, 9,665 tests). A rule is accepted only after the full 550 books by 5,000 windows. The sample cannot declare 75%.

## Why the current best is 64%

Cash when bitcoin is under its 200-day average, or dominance is above its 50-day average, or total cap is under its 50-day average:

- Bitcoin-down windows: about 88% pass. Cash beats falling alts.
- Bitcoin-up windows: about 39% pass. About 23 points of those windows were sat out in cash while the alts rose in dollars, mostly while dominance was rising with bitcoin. About 38 points were invested and still lost to hold or to the plain rebalance.

Half the windows are bitcoin-up. Getting the average to 75% means the up-window pass rate has to reach about 62% without giving back the down-window rate. Changing only the moving-average lengths did not do that.

## Loop

Each generation is one mechanism, not another sweep of the same gate.

1. Write the hypothesis in this file's generation section and in `results/alts-search-log.jsonl` before the run.
2. Score it on the frozen 51 by 200 sample. Log both, hold, plain, bull, and bear rates.
3. Keep the change only if the sample both-rate beats the best kept sample by at least 0.5 points. Otherwise revert the mechanism and take the next family.
4. Run the full 550 by 5,000 only for a kept rule whose sample is at least 75%, or for the final best if the families are exhausted.
5. Stop when the full pass is at least 75%. If every family is worse than the kept rule, log that and stop. Do not drop windows or use prices from after the decision.

The baseline full pass (cash, 200/50/50) is already running and appends `results/alts-5000-summary.json`.

## Families, in order

1. Cash only when the selected coins' own trailing return is negative. A high dominance reading is not enough. When the basket is rising, the moving-average gate still chooses the leader; when the gate fails but the basket is rising, rebalance to the entered weights instead of cash.
2. If family 1 does not lift bitcoin-up windows, replace the "gate failed" action with the single coin that is strongest against bitcoin, sized at the leader weight, and leave the rest in cash.
3. If that still misses, add an extension cap: no coin more than a set percent above its own average can be the leader. The cap is an editable field.
4. Walk-forward switch. At each check, look only at the previous completed window of the same length and repeat whichever of cash, equal weight, or leader won that window. No prices from the current window are used.

Parameters stay on the altcoin panel. A family that wins becomes the default values there.

## Generation 1

Hypothesis: go to cash only when the selected coins' average trailing return is below a hurdle. If the basket is rising, a failed dominance or total-cap filter rebalances to the entered weights instead of cash. The leader still runs when bitcoin, dominance, and total cap all pass.

Lengths tried: 30, 60, and 90 days, hurdles 0, -5%, and -10%, plus a 30-day basket rule with the moving-average gate turned off.

Result: rejected. Best sample was basket90 at 61.6% (bull 46.5%, bear 76.7%), below the kept cash rule at 63.7%. The up-window rate rose, and the down-window rate fell by more.

## Generation 2

Hypothesis: when the moving-average gate fails, hold only the selected coin that is strongest against bitcoin. If none beat bitcoin over the momentum window, hold USDT.

Result: rejected. Best sample was the 90-day momentum version at 49.7% (bull 36.0%, bear 63.5%). The kept rule stays the cash gate at 63.7% on the sample.

## Full pass of the kept rule

Finished 2026-11-22. 550 lists, 5,000 windows, 2,623,234 scored tests. Beat both 62.9%. Bitcoin-up 40.1%. Bitcoin-down 85.7%. Saved as the restore version in `results/alts-champion.json`.

## Generation 3

Hypothesis: do not sell into USDT until the gate has already been off for 14, 30, 60, or 90 days. Until then, leave the book alone.

Result: rejected. Best was 60 days at 62.6% (bull 42.1%, bear 83.1%).

## Generation 4

Hypothesis: before the window starts, look back 90, 180, or 365 days and use whichever of cash, equal weight, or the leader made the most. An override variant uses that choice only for cash or the leader, and otherwise keeps the cash gate.

Result: rejected. Best override was 60.4%. A hindsight pick among the four rules, which is not tradable, would pass 89.5% (bull 83.2%, bear 96.0%). The prior window does not identify which rule that will be.

## Generation 5

Hypothesis: at the window start, use the last 90 days of bitcoin, dominance, and the basket. Cash if bitcoin or the basket is weak. Use the pure leader if dominance is rising while bitcoin is up. Otherwise keep the cash gate. 45 threshold combinations.

Result: best sample 65.2% (bull 42.6%, bear 86.8%) at bitcoin below +20% or basket below +10% goes to cash, and dominance up more than 2 points with bitcoin up uses the pure leader. That is 1.5 points above the kept sample, but it is the maximum of 45 looks at the same sample, and the up-window rate is still 43%. Not promoted. The restore version stays the full-pass cash gate at 62.9%.



