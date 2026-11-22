# What Benjamin Cowen actually uses

Research note, 22 November 2026. This is the input to the bitcoin and dominance rules. It is not a price forecast.

Sources: his public July 2026 cycle memo (https://benjamincowen.com/reports/bitcoin-cycle-memo-july-2026), the dominance chapter in the local macro notes (`financial-education` chapter 12, which cites his videos, Benzinga, Cointelegraph, Daily Hodl, and the August 2026 memo), and his stated alt-season conditions from 22 December 2025.

## The rules he repeats

1. Bitcoin's bull-market line is the weekly band between the 20-week average and the 21-week exponential average. Above it, dips have usually been buyable. Below it, he treats the same band as resistance. A weekly close back above the 50-week average is what would weaken a bearish case. The 200-week average is the long floor, not a 200-day line. In July 2026 he wrote that bitcoin had broken the 200-week average near $57,000 and reclaimed it near $65,300, and that the same break-and-reclaim in 2022 happened well before the low. He did not treat that reclaim as the all-clear. His invalidation was a sustained weekly reclaim of the 50-week average, then near $86,500.

2. Dominance is a relative-strength gauge, not a one-month switch. Rising dominance means bitcoin is beating the rest, in both rallies and selloffs. A real rotation, in his July 2026 words, needs "a sustained decline in Bitcoin dominance excluding stablecoins, persisting over months rather than weeks." A short drop during a crash does not count. He also wants the alt prices themselves to be rising in dollars. His three conditions for an alt season were looser monetary policy, high retail interest, and bitcoin topping on euphoria rather than apathy (22 December 2025). None of those is a 50-day moving-average cross.

3. ETH/BTC is his altcoin index. Ether often keeps bleeding against bitcoin while bitcoin's dollar price is in a bull market. He was early calling the 2024 bottom and said so; the ratio fell further into April 2025. Isolated ether rallies, such as July–August 2025, were not a durable rotation.

4. The default while dominance is rising is bitcoin, not a rotating alt book. Alts, in his words, are oscillators at best and bleeders at worst. The final rotation late in a cycle has been back into bitcoin, not out of it.

## What the simulator had been calling a Cowen gate

The shipped alt gate cashes the book when bitcoin is under its 200-day average, or dominance is above its 50-day average, or total cap is under its 50-day average. That is not his framework.

- 200 days is not the 20-week band, and it is not the 200-week floor.
- A 50-day dominance cross is the "weeks rather than months" signal he rejects.
- Selling the coins into USDT shrinks the coin stack. His July 2026 posture was patience and bitcoin, not a fast exit to cash on a short average. The owner's rule is the same constraint from the other direction: if a stretch cannot make dollars, the book still has to own more coins.

## What we can and cannot test

We can test the weekly band and whether ether is rising in dollars and against bitcoin. That ratio is the signal he treats as the altcoin index, and we have it for the whole Binance history. We cannot see his dominance figure that excludes stablecoins. Our dominance file is a local basket whose membership grows as coins list, so a drop in it before 2022 is often a new listing rather than capital leaving bitcoin. The rule ignores that file before 2022. From 2022 the basket is fixed, and a rise in it blocks a tilt into ether. Retail interest, the Fed's balance sheet, and whether a top was euphoric stay outside the backtest.

## The rule now in the engine

`regime: "cowen-band"`. Bitcoin is above the band only when the last completed weekly close is over both the 20-week average and the 21-week exponential average. A tilt away from bitcoin needs every other selected coin up in dollars over 90 days and above its own 140-day average against bitcoin. From 2022 it also needs the fixed-basket dominance to be falling over those 90 days. Otherwise, if bitcoin is in the book, the book holds bitcoin. If bitcoin is not in the book, it leaves the coins alone. It does not sell into USDT. A coin floor can still keep a minimum share.
