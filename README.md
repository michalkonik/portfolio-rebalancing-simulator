# Portfolio rebalancing simulator

A static research book for crypto portfolios. Pick 1 to 10 coins, set any positive weights, and replay a calendar rebalance on stored 4-hour Binance candles. The page is the whole application: the simulation runs in the browser.

The question it is built to answer is whether a rules-based rebalance helps, or whether it sells a coin that is working in order to buy one that is not.

## What you can run

- Any mix of the stored markets, including a single coin such as untouched BTC.
- Weights in any positive numbers. They are normalized to 100% and the applied weights are shown.
- Clocks: hold, daily, weekly, every two weeks, monthly, or every N days. Weekly and every-two-weeks runs trade on a chosen UTC weekday. Monthly runs trade on a chosen UTC day of the month. The same book is also compared across those clocks.
- Intelligent rebalancing, off until you turn it on. It only changes the percentages of the coins you selected. It does not add bitcoin or USDT. The tilt runs only while bitcoin is above its 200-day average. While bitcoin is below that average, the book is left alone. While bitcoin is above it, the strongest selected coin that is also above its own average gets the leader share. If you include USDT, a coin below its own average is sold into USDT. The default coin average is 50 days, the strength window is 30 days, the leader share is 80%, and the clock is every 14 days. On 138 listed mixes this beat holding 69 times, tied once, and lost 68 times. It is not a rule that wins every window.
- The page opens empty. Save a mix as a book in this browser if you want it again. There are no built-in books on the page.
- A fee and a slippage haircut, in basis points. The default is 10 bps plus 5 bps.
- A drift band, in percentage points. A 33% target with a band of 5 trades only when that coin leaves 28–38%.
- A partial rebalance. 50% closes half the gap, so a winner is only partly sold.
- A trend gate. A coin below its trailing daily average is not bought.
- Two homes for the money when a buy is blocked: leave it in the winners, or park it in USDT.
- A per-coin lock that never sells that coin.
- USDT as a cash sleeve. Its price is 1. It is not a candle file.
- Correlation of daily log returns for the selected dates, including the same correlation on days Bitcoin rose and on days it fell.
- CSV export of the value path and of every fill. The path includes the portfolio, each coin's USDT value, the quantity held, and the BTC price.

The chart is TradingView Lightweight Charts. Dollar mode plots USDT value, with Bitcoin's price on its own axis. Percent mode is TradingView's percent scale: each line is the change from its own first visible point, and scrolling rebases it. Drag to pan and scroll to zoom. Every line can be switched off. Hold, USDT cash, and the plain rebalance start switched off. A table under the chart lists the same numbers by day, week, month, or every 4-hour bar.

The default run is a plain rebalance back to the weights you set. Protect winners is off until you turn it on. A coin with no price yet does not delay the other coins: its weight stays in USDT until it lists, then the next scheduled rebalance buys it. The time axis still covers the dates you picked.

## How a rebalance is filled

Orders fill at the 4-hour close that triggers them. That is slightly kinder than waiting for the next bar's open. The fee and slippage are a haircut on the traded coin value, charged on the way out and on the way in. USDT transfers are not charged.

The moving average uses only daily closes from earlier UTC days, so the decision does not see the current day. A scheduled rebalance that is still inside the band does nothing. With "leave it in the winners", the book sells only enough to fund buys that the trend gate allows. It does not sell a winner into a coin that is failing the average.

"Winner drag" matches each sale's cash to the buys it funded. It is the later gap, in USDT, between keeping the sold coin and holding what was bought instead. A positive number means the sale lagged. It is a description of that path, not a proof about the next one.

## What the first stored window actually did

These are outputs of `scripts/build_study.ts` on the candles in this repo, checked again against the same engine. Starting capital 10,000 USDT. Fee 10 bps, slippage 5 bps. They are one path, not a forecast.

Alt books start on 2024-04-11, the first TAO candle, and end 2026-11-20. Over that window the closes used by the engine were TAO 648.2 to 176.6 (0.27×), PENDLE 7.134 to 1.243 (0.17×), and ZEC 27.02 to 760.79 (28.2×).

| Book | Hold | Weekly plain | Monthly plain | Weekly with the default guard |
| --- | ---: | ---: | ---: | ---: |
| TAO 33 / PENDLE 33 / HBAR 34 | 0.32× | 0.44× | 0.50× | 0.39× |
| TAO 33 / ZEC 33 / PENDLE 34 | 9.57× | 2.02× | 2.58× | 3.09× |
| TAO 33 / UNI 33 / ENA 34 | 0.27× | 0.32× | 0.35× | 0.31× |

BTC left alone from 2023-11-21 to 2026-11-20 finished at 1.56×. BTC 80 / ETH 20, held, finished at 1.41×. Rebalancing that pair did not improve it.

Reading the alt table: TAO / PENDLE / HBAR lost money either way. A plain monthly rebalance lost less than holding, because the book kept selling whatever had just bounced. The trend guard made that book worse, not better. TAO / ZEC / PENDLE is the trap in the other direction. Holding won by a wide margin because ZEC was the winner and a weekly rebalance sold it. The guard kept more of ZEC than a plain rebalance (3.09× versus 2.02×) and still trailed holding (9.57×). On the 10,000 USDT weekly book the measured cost of those sales was about 74,810 USDT by the end.

The equal-weight monthly scan is in `docs/data/preset_study.json` and on the page. Baskets that look strong there are mostly baskets that held a lot of ZEC, and holding still beat rebalancing them. Do not treat the scan as a buy list.

## Data

Candles live in `docs/data/candles/*.csv.gz` with `docs/data/manifest.json`. They are Binance spot USDT klines, 4-hour bars, requested back five years from the day they were downloaded. A market that listed later starts on its first Binance candle. The page says so.

`GRAM` is Toncoin after Binance's 2026 rename. `scripts/stitch_gram.py` prepends the old `TONUSDT` series when the join closes agree. Search for TON in the page and it selects GRAM.

PEAQ and GRASS have no Binance USDT spot market, so they are not in the book.

Stablecoins and tokenized-stock symbols are left out of the 150 so they do not crowd out coins. USDT cash is still available inside the simulator.

Refresh later, from a checkout:

```bash
python3 scripts/download_data.py --update --years 5 --limit 150
python3 scripts/stitch_gram.py
node --experimental-strip-types scripts/build_study.ts
```

Or run the **Update market data** GitHub Action. It commits new candles to `main`. Reload the site after it finishes. No API key is required; the endpoints are public.

`docs/data/preset_study.json` is a measured replay of old draft books and an equal-weight monthly scan. The page does not load it. Treat it as one historical window with the default fee, not as a ranking of what to buy.

## Develop

```bash
npm install
npm test
npm run dev
npm run build
```

The dev server and the production build both use the base path `/portfolio-rebalancing-simulator/`. GitHub Pages should serve the `docs/` directory of `main`.

## Limits

Closes are not an order book. There is no market impact, no missed fill, and no tax. A coin is not marked before its first candle; until then its target weight sits in USDT. A rebalance premium in one window often reverses when the coins are highly correlated or the fee is higher. Nothing here is a forecast or a recommendation.
