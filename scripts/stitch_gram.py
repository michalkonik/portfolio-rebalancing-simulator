#!/usr/bin/env python3
"""Extend GRAM candles backward with TONUSDT.

Binance renamed the spot market from TONUSDT to GRAMUSDT in 2026. The old
symbol still serves historical klines. This joins them on the first GRAM bar
when the two closes agree, and records the join on the manifest.
"""

from __future__ import annotations

import gzip
import json
import os
import time
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA = os.path.join(ROOT, "docs", "data")
GRAM = os.path.join(DATA, "candles", "GRAM.csv.gz")
MANIFEST = os.path.join(DATA, "manifest.json")
INTERVAL_MS = 4 * 60 * 60 * 1000
UA = "portfolio-rebalancing-simulator/1.0 (research; public market data)"


def get_json(url: str):
    delay = 1.5
    for _ in range(6):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=40) as resp:
                return json.loads(resp.read().decode())
        except Exception:
            time.sleep(delay)
            delay = min(delay * 2, 20)
    raise RuntimeError(f"failed {url}")


def read_gz(path: str) -> list[list[str]]:
    rows = []
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        for i, line in enumerate(handle):
            if i == 0 or not line.strip():
                continue
            rows.append(line.strip().split(",")[:6])
    return rows


def write_gz(path: str, rows: list[list[str]]) -> None:
    tmp = path + ".tmp"
    with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=9) as handle:
        handle.write("t,o,h,l,c,v\n")
        for row in rows:
            handle.write(",".join(row) + "\n")
    os.replace(tmp, path)


def download_ton(start_ms: int, end_ms: int) -> list[list[str]]:
    rows: list[list[str]] = []
    cursor = start_ms
    while cursor < end_ms:
        url = (
            "https://api.binance.com/api/v3/klines?symbol=TONUSDT&interval=4h"
            f"&startTime={cursor}&endTime={end_ms}&limit=1000"
        )
        batch = get_json(url)
        if not batch:
            break
        for k in batch:
            rows.append([str(int(k[0])), k[1], k[2], k[3], k[4], k[5]])
        nxt = int(batch[-1][0]) + INTERVAL_MS
        if nxt <= cursor:
            break
        cursor = nxt
        if len(batch) < 1000:
            break
        time.sleep(0.2)
    return rows


def main() -> None:
    if not os.path.exists(GRAM):
        raise SystemExit("GRAM candles are not downloaded yet")
    gram = read_gz(GRAM)
    if not gram:
        raise SystemExit("GRAM file is empty")
    first = int(gram[0][0])
    # Already stitched if history begins well before the July 2026 listing.
    if first < 1780000000000:
        print(f"GRAM already starts at {first}; leaving it")
    else:
        ton = download_ton(1637366400000, first - 1)
        ton = [row for row in ton if int(row[0]) < first]
        if not ton:
            raise SystemExit("no TONUSDT history returned")
        prev = ton[-1]
        gap = abs(float(prev[4]) - float(gram[0][4])) / float(prev[4])
        print(f"join TON {prev[0]} close {prev[4]} -> GRAM {gram[0][0]} close {gram[0][4]} gap={gap:.3%}")
        if gap > 0.25:
            raise SystemExit("refusing to stitch; closes do not agree")
        merged = ton + gram
        write_gz(GRAM, merged)
        print(f"GRAM candles {len(merged)}")
        gram = merged
    if os.path.exists(MANIFEST):
        with open(MANIFEST, encoding="utf-8") as handle:
            manifest = json.load(handle)
        for coin in manifest.get("coins", []):
            if coin.get("symbol") == "GRAM":
                coin["name"] = "Gram (formerly Toncoin)"
                coin["start"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(gram[0][0]) / 1000))
                coin["end"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(gram[-1][0]) / 1000))
                coin["candles"] = len(gram)
                coin["history_note"] = "TONUSDT candles are prepended up to the Binance rename. The 2026 rename was 1:1."
        notes = manifest.setdefault("notes", [])
        line = "GRAM history before the Binance rename is TONUSDT, joined because the rename did not change balances."
        if line not in notes:
            notes.append(line)
        tmp = MANIFEST + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, indent=2)
            handle.write("\n")
        os.replace(tmp, MANIFEST)
        print("manifest updated")


if __name__ == "__main__":
    main()
