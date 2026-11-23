#!/usr/bin/env python3
"""Build daily TOTAL and BTCD candles from the stored coin files.

CoinGecko's free history is one year, so the long series is this universe:
coins listed by 2021-12-20, weighted by today's circulating supply
(manifest market cap divided by the last stored close). Stablecoins are
already absent. BTCD is bitcoin's share of that basket, in percent.
TOTAL is the basket's dollar value. Neither series is a tradable coin.
"""

from __future__ import annotations

import gzip
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs" / "data"
CANDLES = DATA / "candles"
CUTOFF = int(datetime(2021, 12, 20, tzinfo=timezone.utc).timestamp() * 1000)
DAY = 86_400_000


def last_and_first(path: Path) -> tuple[int, float] | None:
    first = None
    last = None
    with gzip.open(path, "rt") as handle:
        for line in handle:
            if not line or line.startswith("t"):
                continue
            parts = line.split(",")
            if len(parts) < 5:
                continue
            ts = int(float(parts[0]))
            close = float(parts[4])
            if close <= 0:
                continue
            if first is None:
                first = ts
            last = close
    if first is None or last is None:
        return None
    return first, last


def main() -> None:
    manifest = json.loads((DATA / "manifest.json").read_text())
    supply: dict[str, float] = {}
    for coin in manifest["coins"]:
        symbol = coin["symbol"]
        cap = coin.get("market_cap") or 0
        path = CANDLES / f"{symbol}.csv.gz"
        if symbol == "USDT" or not cap or not path.exists():
            continue
        span = last_and_first(path)
        if span is None or span[0] > CUTOFF:
            continue
        supply[symbol] = cap / span[1]
    if "BTC" not in supply:
        raise SystemExit("BTC is missing from the basket")
    daily: dict[int, dict[str, float]] = defaultdict(dict)
    for symbol in supply:
        with gzip.open(CANDLES / f"{symbol}.csv.gz", "rt") as handle:
            for line in handle:
                if not line or line.startswith("t"):
                    continue
                parts = line.split(",")
                if len(parts) < 5:
                    continue
                ts = int(float(parts[0]))
                close = float(parts[4])
                if close <= 0:
                    continue
                daily[ts - (ts % DAY)][symbol] = close
    lines_total = ["t,o,h,l,c,v"]
    lines_dom = ["t,o,h,l,c,v"]
    for day in sorted(daily):
        prices = daily[day]
        if "BTC" not in prices:
            continue
        total = sum(supply[symbol] * price for symbol, price in prices.items() if symbol in supply)
        if total <= 0:
            continue
        dom = 100.0 * supply["BTC"] * prices["BTC"] / total
        lines_total.append(f"{day},{total},{total},{total},{total},0")
        lines_dom.append(f"{day},{dom},{dom},{dom},{dom},0")
    for name, lines in (("TOTAL.csv.gz", lines_total), ("BTCD.csv.gz", lines_dom)):
        with gzip.open(CANDLES / name, "wt") as handle:
            handle.write("\n".join(lines) + "\n")
        print(f"{name} days {len(lines) - 1} coins {len(supply)}")


if __name__ == "__main__":
    main()
