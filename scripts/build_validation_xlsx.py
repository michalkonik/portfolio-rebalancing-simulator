#!/usr/bin/env python3
"""Turn results/validation.json into a 4-tab workbook."""

import json
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "results" / "validation.json"
DEST = ROOT / "results" / "rebalance-validation.xlsx"
DESKTOP = Path("/home/mkoniu/Desktop/rebalance-validation.xlsx")

TABS = [
    ("btc-eth", "BTC-ETH"),
    ("alts-stable", "Alts-stable"),
    ("btc-alts", "BTC-alts"),
    ("alts", "Alts"),
]

HEADER_FILL = PatternFill("solid", fgColor="1F4E79")
HEADER_FONT = Font(color="FFFFFF", bold=True)
SECTION_FONT = Font(bold=True, size=14)
WRAP = Alignment(wrap_text=True, vertical="top")


def pct(value):
    return None if value is None else value


def main():
    data = json.loads(SRC.read_text())
    windows = data["windows"]
    wb = Workbook()
    default = wb.active
    wb.remove(default)
    for algo, title in TABS:
        write_tab(wb.create_sheet(title), title, algo, data, windows)
    DEST.parent.mkdir(parents=True, exist_ok=True)
    wb.save(DEST)
    wb.save(DESKTOP)
    print(DEST)
    print(DESKTOP)


def write_tab(ws, title, algo, data, windows):
    ws.sheet_view.showGridLines = False
    ws["A1"] = title
    ws["A1"].font = Font(bold=True, size=16)
    ws["A2"] = (
        "Rows are every coin configuration in rebalance-portfolios.json. "
        "A row is scored only when that configuration is the book this algo is allowed to run. "
        "Beat means final value greater by more than 0.01 USDT. "
        f"Capital {data['capital']} USDT, fee {data['feeBps']} bps, slippage {data['slippageBps']} bps."
    )
    ws["A2"].alignment = WRAP
    ws.merge_cells("A2:H2")
    ws.row_dimensions[2].height = 48

    row = 4
    ws.cell(row, 1, "Time ranges tested on every applicable configuration").font = SECTION_FONT
    row += 1
    for col, label in enumerate(["Name", "Start UTC", "End UTC"], 1):
        cell = ws.cell(row, col, label)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
    for window in windows:
        row += 1
        start = window["startMs"]
        end = window["endMs"]
        ws.cell(row, 1, window["name"])
        ws.cell(row, 2, ms_day(start))
        ws.cell(row, 3, ms_day(end))

    versions = data["versions"]
    first_key = None
    for version in versions:
        block = version["algos"][algo]
        key = json.dumps({"everyDays": block["everyDays"], "spec": block["spec"]}, sort_keys=True)
        row += 2
        ws.cell(row, 1, f"{version['id']}").font = SECTION_FONT
        row += 1
        if first_key is None:
            first_key = key
        elif key == first_key:
            ws.cell(row, 1, "Same rule and same results as v1. Not repeated.")
            continue
        ws.cell(row, 1, version["note"]).alignment = WRAP
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=8)
        ws.row_dimensions[row].height = 48
        row += 1
        ws.cell(row, 1, f"Check every {block['everyDays']} days")
        row += 1
        labels = [
            ("Applicable window tests", block["eligible"] + block["skipped"]),
            ("Eligible windows", block["eligible"]),
            ("Skipped (no usable history)", block["skipped"]),
            ("Not this algo", block["notApplicable"]),
            ("Beat hold", block["beatHold"]),
            ("Beat hold %", block["beatHoldRate"]),
            ("Beat plain rebalance", block["beatPlain"]),
            ("Beat plain %", block["beatPlainRate"]),
            ("Beat both", block["beatBoth"]),
            ("Beat both %", block["beatBothRate"]),
        ]
        for col, (label, value) in enumerate(labels, 1):
            head = ws.cell(row, col, label)
            head.fill = HEADER_FILL
            head.font = HEADER_FONT
            cell = ws.cell(row + 1, col, value)
            if isinstance(value, float):
                cell.number_format = "0.0%"
        row += 3
        headers = ["Group", "Coins", "Applicable"]
        for window in windows:
            headers.extend(
                [
                    f"{window['name']} final",
                    f"{window['name']} hold",
                    f"{window['name']} plain",
                    f"{window['name']} beat hold",
                    f"{window['name']} beat plain",
                    f"{window['name']} beat both",
                ]
            )
        for col, label in enumerate(headers, 1):
            cell = ws.cell(row, col, label)
            cell.fill = HEADER_FILL
            cell.font = HEADER_FONT
        for book in block["rows"]:
            row += 1
            ws.cell(row, 1, book["group"])
            ws.cell(row, 2, " / ".join(book["coins"]))
            ws.cell(row, 3, "yes" if book["applicable"] else "no")
            if not book["applicable"]:
                continue
            col = 4
            by_name = {test["window"]: test for test in book["tests"]}
            for window in windows:
                test = by_name.get(window["name"])
                if test is None or not test.get("ok"):
                    ws.cell(row, col, test.get("error") if test else "missing")
                    col += 6
                    continue
                for key_name in ("finalEquity", "hold", "plain"):
                    cell = ws.cell(row, col, round(test[key_name], 2))
                    cell.number_format = "#,##0.00"
                    col += 1
                for key_name in ("aheadHold", "aheadPlain", "aheadBoth"):
                    ws.cell(row, col, "yes" if test[key_name] else "no")
                    col += 1
        ws.auto_filter.ref = None
        ws.freeze_panes = "D20"
        ws.column_dimensions["A"].width = 22
        ws.column_dimensions["B"].width = 36
        ws.column_dimensions["C"].width = 14
        for col in range(4, 4 + 6 * len(windows)):
            ws.column_dimensions[get_column_letter(col)].width = 16


def ms_day(ms):
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d")


if __name__ == "__main__":
    main()
