#!/usr/bin/env python3
"""
Quick helper to pull the last 20 analytics rows from D1 and print them with
human-readable timestamps.
"""

import json
import subprocess
from datetime import datetime, timezone
from urllib.parse import urlparse


DB_NAME = "emstat"  # set to your D1 name if different


def run_sql(sql: str):
    cmd = [
        "wrangler",
        "d1",
        "execute",
        DB_NAME,
        "--remote",
        "--command",
        sql,
        "--json",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print("SQL error:", result.stderr.strip() or result.stdout.strip())
        return []

    stdout = result.stdout.strip()
    if not stdout:
        return []

    try:
        obj = json.loads(stdout)
    except json.JSONDecodeError:
        print("Failed to parse JSON from wrangler; raw output:")
        print(stdout)
        return []

    if isinstance(obj, list) and obj and isinstance(obj[0], dict):
        first = obj[0]
        if "results" in first and isinstance(first["results"], list):
            return first["results"]
    if isinstance(obj, dict) and "results" in obj and isinstance(obj["results"], list):
        return obj["results"]

    return obj if isinstance(obj, list) else []


def format_ts(ts_ms):
    try:
        ts_ms = int(ts_ms)
    except (TypeError, ValueError):
        return "-"
    dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%d %H:%M:%S UTC")


def clean_path(path_val: str) -> str:
    """
    If the path is a full URL (e.g., recorded from referrer), trim to just the
    path portion and drop the query string for readability.
    """
    if not path_val:
        return ""
    if path_val.startswith(("http://", "https://")):
        parsed = urlparse(path_val)
        return parsed.path or "/"
    if "?" in path_val:
        return path_val.split("?", 1)[0]
    return path_val


def print_rows(rows):
    if not rows:
        print("(no rows)")
        return

    columns = [
        "timestamp",
        "path",
        "utm_source",
        "scroll_pct",
        "duration_s",
        "device_browser",
        "country",
        "city",
    ]
    widths = {col: len(col) for col in columns}

    processed = []
    for r in rows:
        row = {
            "timestamp": format_ts(r.get("ts")),
            "path": clean_path(r.get("path") or ""),
            "utm_source": r.get("utm_source") or "",
            "scroll_pct": r.get("scroll_pct") if r.get("scroll_pct") is not None else "",
            "duration_s": (
                round(int(r.get("duration_ms", 0)) / 1000, 2)
                if r.get("duration_ms") is not None
                else ""
            ),
            "device_browser": r.get("device_browser") or "",
            "country": r.get("country") or "",
            "city": r.get("city") or "",
        }
        processed.append(row)
        for col, val in row.items():
            widths[col] = max(widths[col], len(str(val)))

    header = "  ".join(col.ljust(widths[col]) for col in columns)
    print(header)
    print("-" * (sum(widths.values()) + 2 * (len(columns) - 1)))

    for row in processed:
        line = "  ".join(str(row[col]).ljust(widths[col]) for col in columns)
        print(line)


def main():
    sql = (
        "SELECT * FROM ("
        "  SELECT ts, path, utm_source, scroll_pct, duration_ms, device_browser, country, city "
        "  FROM analytics "
        "  ORDER BY ts DESC "
        "  LIMIT 20"
        ") "
        "ORDER BY ts ASC;"
    )
    rows = run_sql(sql)
    print_rows(rows)


if __name__ == "__main__":
    main()
