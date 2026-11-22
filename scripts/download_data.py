#!/usr/bin/env python3
"""Download Binance spot 4h candles for a broad crypto universe.

Public market data only. No API key. Writes gzipped CSV under docs/data/candles
and docs/data/manifest.json. Safe to resume: each coin is written atomically
and an existing file that already reaches the target end is skipped.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR = os.path.join(ROOT, "docs", "data")
CANDLE_DIR = os.path.join(DATA_DIR, "candles")
MANIFEST_PATH = os.path.join(DATA_DIR, "manifest.json")

INTERVAL = "4h"
INTERVAL_MS = 4 * 60 * 60 * 1000
BINANCE = "https://api.binance.com"
UA = "portfolio-rebalancing-simulator/1.0 (research; public market data)"

# Coins from the owner's draft cycle plan. Included whenever Binance has a
# USDT spot market, even if they sit outside the top 150 by market cap.
FORCE_BASES = {
    "BTC", "ETH", "SOL", "SUI", "ARB", "ZEC", "LINK", "HBAR", "TON", "GRAM",
    "RENDER", "SKY", "ATOM", "NEAR", "TAO", "ENA", "UNI", "HYPE", "INJ", "ZRO",
    "AAVE", "ADA", "WLD", "PENDLE", "PEPE", "ONDO", "ETHFI", "LDO", "RUNE",
    "ZK", "GRASS", "PEAQ", "XRP", "BNB", "DOGE", "AVAX", "DOT", "LTC", "BCH",
    "TRX", "SHIB", "FIL", "APT", "OP", "ARB", "TIA", "SEI", "IMX", "STX",
}

LEVERAGE_SUFFIXES = ("UP", "DOWN", "BULL", "BEAR")
# Cash and tokenized equities are not part of the crypto universe the book trades.
SKIP_BASES = {
    "USDC", "USDE", "USD1", "USDS", "RLUSD", "FDUSD", "TUSD", "BFUSD", "FRAX",
    "USDP", "DAI", "USDD", "PYUSD", "GUSD", "EURC", "AEUR", "EURI", "USD0",
    "USDY", "NVDAB", "GOOGLB", "CRCLB", "SOXLB", "MUB", "SPCXB", "TSLAB",
    "AAPLB", "AMZNB", "MSFTB", "METAB", "COINB", "QQQB", "SPYB",
}


def now_ms() -> int:
    return int(time.time() * 1000)


def iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def day(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


_RATE_LOCK = threading.Lock()
_NEXT_AT = 0.0


def get_json(url: str, retries: int = 6) -> object:
    global _NEXT_AT
    delay = 1.5
    last = None
    for _ in range(retries):
        with _RATE_LOCK:
            wait = _NEXT_AT - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            _NEXT_AT = time.monotonic() + 0.15
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=40) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code in (418, 429, 500, 502, 503, 504):
                time.sleep(delay)
                delay = min(delay * 2, 40)
                continue
            raise
        except urllib.error.URLError as exc:
            last = exc
            time.sleep(delay)
            delay = min(delay * 2, 40)
    raise RuntimeError(f"failed to fetch {url}: {last}")


def fetch_markets() -> list[dict]:
    """Top coins by market cap. CoinGecko first, CoinPaprika if it is down."""
    coins: list[dict] = []
    try:
        for page in (1, 2, 3):
            url = (
                "https://api.coingecko.com/api/v3/coins/markets"
                f"?vs_currency=usd&order=market_cap_desc&per_page=250&page={page}&sparkline=false"
            )
            batch = get_json(url)
            if not isinstance(batch, list) or not batch:
                break
            for row in batch:
                coins.append(
                    {
                        "id": row.get("id") or "",
                        "symbol": str(row.get("symbol") or "").upper(),
                        "name": row.get("name") or "",
                        "market_cap_rank": row.get("market_cap_rank"),
                        "market_cap": row.get("market_cap"),
                    }
                )
            if len(batch) < 250:
                break
            time.sleep(1.2)
        if len(coins) >= 100:
            print(f"universe source=coingecko coins={len(coins)}", flush=True)
            return coins
    except Exception as exc:  # noqa: BLE001 — fallback is the point
        print(f"coingecko unavailable: {exc}", flush=True)

    paprika = get_json("https://api.coinpaprika.com/v1/tickers?quotes=USD")
    if not isinstance(paprika, list):
        raise RuntimeError("no market-cap source available")
    ranked = []
    for row in paprika:
        quotes = row.get("quotes") or {}
        usd = quotes.get("USD") or {}
        ranked.append(
            {
                "id": row.get("id") or "",
                "symbol": str(row.get("symbol") or "").upper(),
                "name": row.get("name") or "",
                "market_cap_rank": row.get("rank"),
                "market_cap": usd.get("market_cap"),
            }
        )
    ranked.sort(key=lambda r: (r["market_cap_rank"] is None, r["market_cap_rank"] or 10**9))
    print(f"universe source=coinpaprika coins={len(ranked)}", flush=True)
    return ranked


def fetch_binance_pairs() -> dict[str, dict]:
    info = get_json(f"{BINANCE}/api/v3/exchangeInfo?permissions=SPOT")
    pairs: dict[str, dict] = {}
    for sym in info["symbols"]:
        if sym.get("status") != "TRADING":
            continue
        if sym.get("quoteAsset") != "USDT":
            continue
        if not sym.get("isSpotTradingAllowed", True):
            continue
        base = sym["baseAsset"].upper()
        if not base.isascii() or not base.replace(" ", "").isalnum():
            continue
        if base.endswith(LEVERAGE_SUFFIXES):
            continue
        if any(tag in (base, sym["symbol"]) for tag in ("UPUSDT", "DOWNUSDT")):
            continue
        pairs[base] = {
            "pair": sym["symbol"],
            "base": base,
            "quote": "USDT",
        }
    print(f"binance usdt pairs={len(pairs)}", flush=True)
    return pairs


def read_existing(path: str) -> tuple[list[list[str]], int]:
    if not os.path.exists(path):
        return [], 0
    rows: list[list[str]] = []
    last = 0
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        for i, line in enumerate(handle):
            line = line.strip()
            if not line or i == 0:
                continue
            parts = line.split(",")
            if len(parts) < 6:
                continue
            t = int(parts[0])
            if t > last:
                rows.append(parts[:6])
                last = t
            elif t == last:
                continue
            else:
                rows.append(parts[:6])
    rows.sort(key=lambda r: int(r[0]))
    dedup = []
    seen = set()
    for row in rows:
        t = int(row[0])
        if t in seen:
            continue
        seen.add(t)
        dedup.append(row)
        last = t
    return dedup, last


def download_klines(pair: str, start_ms: int, end_ms: int) -> list[list[str]]:
    rows: list[list[str]] = []
    cursor = start_ms
    while cursor < end_ms:
        url = (
            f"{BINANCE}/api/v3/klines?symbol={pair}&interval={INTERVAL}"
            f"&startTime={cursor}&endTime={end_ms}&limit=1000"
        )
        batch = get_json(url)
        if not isinstance(batch, list) or not batch:
            break
        for k in batch:
            open_ms = int(k[0])
            if open_ms < start_ms or open_ms > end_ms:
                continue
            rows.append(
                [
                    str(open_ms),
                    k[1],
                    k[2],
                    k[3],
                    k[4],
                    k[5],
                ]
            )
        last_open = int(batch[-1][0])
        next_cursor = last_open + INTERVAL_MS
        if next_cursor <= cursor:
            break
        cursor = next_cursor
        if len(batch) < 1000:
            break
        time.sleep(0.05)
    return rows


def write_candles(path: str, rows: list[list[str]]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=9) as handle:
        handle.write("t,o,h,l,c,v\n")
        for row in rows:
            handle.write(",".join(row) + "\n")
    os.replace(tmp, path)


def merge_rows(old: list[list[str]], new: list[list[str]]) -> list[list[str]]:
    by_t = {int(r[0]): r for r in old}
    for row in new:
        by_t[int(row[0])] = row
    return [by_t[k] for k in sorted(by_t)]


def _coin_row(base: str, pairs: dict[str, dict], meta: dict | None) -> dict:
    return {
        "symbol": base,
        "pair": pairs[base]["pair"],
        "name": (meta or {}).get("name") or base,
        "coingecko_id": (meta or {}).get("id") or "",
        "market_cap_rank": None if meta is None else meta.get("market_cap_rank"),
        "market_cap": None if meta is None else meta.get("market_cap"),
        "forced": base in FORCE_BASES,
    }


def select_universe(markets: list[dict], pairs: dict[str, dict], limit: int) -> list[dict]:
    """Top `limit` Binance-listed coins by market cap, plus draft-plan tickers."""
    by_symbol: dict[str, dict] = {}
    for meta in markets:
        symbol = meta.get("symbol") or ""
        if symbol not in pairs or symbol in by_symbol:
            continue
        by_symbol[symbol] = meta
    def tradable(symbol: str) -> bool:
        if symbol in SKIP_BASES:
            return False
        name = (by_symbol.get(symbol) or {}).get("name") or ""
        lowered = name.lower()
        return "tokenized" not in lowered and "xstock" not in lowered

    ranked = sorted(
        (symbol for symbol in by_symbol if tradable(symbol)),
        key=lambda s: (
            by_symbol[s].get("market_cap_rank") is None,
            by_symbol[s].get("market_cap_rank") or 10**9,
        ),
    )
    chosen: list[dict] = []
    seen: set[str] = set()
    for base in ranked:
        if len(chosen) >= limit:
            break
        chosen.append(_coin_row(base, pairs, by_symbol[base]))
        seen.add(base)
    for base in sorted(FORCE_BASES):
        if base in seen or base not in pairs:
            continue
        chosen.append(_coin_row(base, pairs, by_symbol.get(base)))
        seen.add(base)
    return chosen


def coin_done(path: str, start_ms: int, end_ms: int) -> bool:
    if not os.path.exists(path):
        return False
    rows, last = read_existing(path)
    if not rows or last <= 0 or last < end_ms - 2 * INTERVAL_MS:
        return False
    return int(rows[0][0]) <= start_ms + INTERVAL_MS


def fetch_one(coin: dict, start_ms: int, end_ms: int, update: bool) -> dict:
    path = os.path.join(CANDLE_DIR, f"{coin['symbol']}.csv.gz")
    if coin_done(path, start_ms, end_ms) and not update:
        rows, last = read_existing(path)
        print(f"skip {coin['symbol']} candles={len(rows)} through={day(last)}", flush=True)
    else:
        existing, last = read_existing(path) if update or os.path.exists(path) else ([], 0)
        fresh: list[list[str]] = []
        first = int(existing[0][0]) if existing else 0
        if first and first > start_ms + INTERVAL_MS:
            fresh.extend(download_klines(coin["pair"], start_ms, first - 1))
        fetch_from = start_ms if last <= 0 else last + INTERVAL_MS
        if last <= 0 or last < end_ms - 2 * INTERVAL_MS:
            fresh.extend(download_klines(coin["pair"], fetch_from, end_ms))
        rows = merge_rows(existing, fresh) if existing else fresh
        # Drop the still-forming last candle if it is the current open bar.
        if rows and int(rows[-1][0]) + INTERVAL_MS > now_ms():
            rows = rows[:-1]
        write_candles(path, rows)
        print(
            f"saved {coin['symbol']} {coin['pair']} candles={len(rows)} "
            f"{day(int(rows[0][0])) if rows else '-'} -> {day(int(rows[-1][0])) if rows else '-'}",
            flush=True,
        )
    if not rows:
        return {**coin, "candles": 0, "start": None, "end": None, "path": None}
    return {
        **coin,
        "candles": len(rows),
        "start": iso(int(rows[0][0])),
        "end": iso(int(rows[-1][0])),
        "start_ms": int(rows[0][0]),
        "end_ms": int(rows[-1][0]),
        "path": f"data/candles/{coin['symbol']}.csv.gz",
    }


def write_manifest(coins: list[dict], start_ms: int, end_ms: int) -> None:
    usable = [c for c in coins if c.get("candles", 0) > 0]
    usable.sort(key=lambda c: (c.get("market_cap_rank") is None, c.get("market_cap_rank") or 10**9, c["symbol"]))
    payload = {
        "generated_at": iso(now_ms()),
        "interval": INTERVAL,
        "quote": "USDT",
        "source": "Binance spot public klines",
        "requested_start": day(start_ms),
        "requested_end": day(end_ms),
        "notes": [
            "Prices are 4h candle OHLC in USDT.",
            "USDT itself is synthetic in the simulator at a price of 1 and is not a file.",
            "A coin's history starts when its Binance USDT market starts, which can be after the requested start.",
        ],
        "count": len(usable),
        "coins": [
            {
                "symbol": c["symbol"],
                "name": c["name"],
                "pair": c["pair"],
                "coingecko_id": c.get("coingecko_id") or "",
                "market_cap_rank": c.get("market_cap_rank"),
                "market_cap": c.get("market_cap"),
                "candles": c["candles"],
                "start": c["start"],
                "end": c["end"],
                "path": c["path"],
            }
            for c in usable
        ],
    }
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = MANIFEST_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    os.replace(tmp, MANIFEST_PATH)
    print(f"manifest coins={len(usable)} -> {MANIFEST_PATH}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Download 4h USDT candles for the simulator.")
    parser.add_argument("--years", type=float, default=5.0, help="Years of history to request. Default 5.")
    parser.add_argument("--limit", type=int, default=150, help="How many top-cap coins to keep, before forced extras.")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--update", action="store_true", help="Refresh coins that already have files.")
    parser.add_argument("--symbols", default="", help="Comma-separated bases to download. Leaves every other file in place.")
    args = parser.parse_args()

    end_ms = now_ms() - INTERVAL_MS
    start_ms = end_ms - int(args.years * 365.25 * 24 * 60 * 60 * 1000)
    print(f"range {day(start_ms)} -> {day(end_ms)} interval={INTERVAL}", flush=True)
    wanted = {part.strip().upper() for part in args.symbols.split(",") if part.strip()}

    pairs = fetch_binance_pairs()
    if wanted:
        universe = [_coin_row(base, pairs, None) for base in sorted(wanted) if base in pairs]
        missing = sorted(wanted - pairs.keys())
        if missing:
            print("no binance usdt market: " + ", ".join(missing), flush=True)
    else:
        markets = fetch_markets()
        universe = select_universe(markets, pairs, args.limit)
    print(f"selected {len(universe)} coins", flush=True)
    missing_force = sorted(b for b in FORCE_BASES if b not in pairs)
    if missing_force:
        print("no binance usdt market: " + ", ".join(missing_force), flush=True)

    results = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = [pool.submit(fetch_one, coin, start_ms, end_ms, args.update) for coin in universe]
        for fut in as_completed(futures):
            try:
                results.append(fut.result())
            except Exception as exc:  # noqa: BLE001 — one market must not drop the rest
                print(f"failed coin: {exc}", flush=True)
    if not wanted:
        write_manifest(results, start_ms, end_ms)
    keep = {coin["symbol"] for coin in universe}
    if not wanted and os.path.isdir(CANDLE_DIR):
        for name in os.listdir(CANDLE_DIR):
            if not name.endswith(".csv.gz"):
                continue
            symbol = name[: -len(".csv.gz")]
            if symbol not in keep:
                os.remove(os.path.join(CANDLE_DIR, name))
                print(f"removed {symbol}", flush=True)
    short = [c for c in results if c.get("candles", 0) < 6 * 365]
    print(f"done usable={sum(1 for c in results if c.get('candles', 0))} short_lt_1y={len([c for c in results if 0 < c.get('candles', 0) < 6*365])}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        raise SystemExit(130)
