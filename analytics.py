#!/usr/bin/env python3
import json
import subprocess
from datetime import datetime, timezone
import plotext as plt



DB_NAME = "emstat"  # change this to your D1 name

# Colors
C_RESET = "\033[0m"
C_BOLD = "\033[1m"
C_DIM = "\033[2m"
C_BLUE = "\033[94m"
C_GREEN = "\033[92m"
C_YELLOW = "\033[93m"
C_CYAN = "\033[96m"
C_MAGENTA = "\033[95m"

def run_sql(sql):
    """
    Run `wrangler d1 execute` with --json and return rows (list of dicts).
    Works with wrangler 4.50's JSON shape.
    """
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
        print(C_YELLOW + "SQL error:" + C_RESET, result.stderr.strip())
        return []

    stdout = result.stdout.strip()
    if not stdout:
        return []

    try:
        obj = json.loads(stdout)
    except json.JSONDecodeError:
        print(C_YELLOW + "Failed to parse JSON from wrangler; raw output:" + C_RESET)
        print(stdout)
        return []

    # Wrangler 4.50 format is typically:
    # [
    #   {
    #     "results": [ { ... }, ... ],
    #     "success": true,
    #     "meta": {...}
    #   }
    # ]
    if isinstance(obj, list):
        if not obj:
            return []
        first = obj[0]
        if isinstance(first, dict) and "results" in first and isinstance(first["results"], list):
            return first["results"]
        # fallback: maybe it's already a list of row dicts
        return obj

    if isinstance(obj, dict):
        # Older or alternate shapes
        if "results" in obj and isinstance(obj["results"], list):
            return obj["results"]
        if "result" in obj:
            res = obj["result"]
            if isinstance(res, list):
                return res
            if isinstance(res, dict) and "results" in res and isinstance(res["results"], list):
                return res["results"]
        return []

    return []




def print_table(title, rows, columns):
    print(f"\n{C_BOLD}{title}{C_RESET}")
    if not rows:
        print(C_DIM + "(no data)" + C_RESET)
        return

    widths = {col: len(col) for col in columns}
    for row in rows:
        for col in columns:
            widths[col] = max(widths[col], len(str(row.get(col, ""))))

    header = "  ".join(C_CYAN + col.ljust(widths[col]) + C_RESET for col in columns)
    print(header)
    print("-" * (sum(widths.values()) + 2 * (len(columns) - 1)))

    for r in rows:
        line = "  ".join(str(r.get(col, "")).ljust(widths[col]) for col in columns)
        print(line)


def print_bar_chart(title, rows, label_key, value_key, max_width=40):
    print(f"\n{C_BOLD}{title}{C_RESET}")
    if not rows:
        print(C_DIM + "(no data)" + C_RESET)
        return

    max_val = max((r.get(value_key, 0) or 0) for r in rows) or 1

    for r in rows:
        label = str(r.get(label_key, ""))
        val = int(r.get(value_key, 0) or 0)
        bar_len = max(1, int(val / max_val * max_width)) if val > 0 else 0
        bar = "█" * bar_len
        print(f"{label:>10} {bar} {val}")

def plot_daily_pageviews(daily_rows):
    import plotext as plt
    if not daily_rows:
        print("No daily data to plot.")
        return

    # chronological order
    days = [row["day"] for row in daily_rows]
    views = [row["views"] for row in daily_rows]
    x = list(range(len(days)))

    plt.clear_figure()
    plt.limit_size(True, True)
    plt.plot_size(30, 10)

    plt.title("Daily Pageviews (Last 30 Days)")
    plt.xlabel("Index (0 = oldest)")
    plt.ylabel("Views")

    # disable date handling completely
    plt.date_form("none")

    plt.plot(x, views, marker="dot", color="cyan")
    plt.scatter(x, views, color="red")

    # Add x-labels underneath if desired
    for i, d in enumerate(days):
        print(f"{i}: {d}")

    plt.show()



def plot_monthly_pageviews(monthly_rows):
    import plotext as plt
    if not monthly_rows:
        print("No monthly data to plot.")
        return

    months = [row["month"] for row in monthly_rows]
    views = [row["views"] for row in monthly_rows]
    x = list(range(len(months)))

    plt.clear_figure()
    plt.limit_size(True, True)
    plt.plot_size(30, 10)

    plt.title("Monthly Pageviews (All Time)")
    plt.xlabel("Index (oldest → newest)")
    plt.ylabel("Views")

    plt.date_form("none")

    plt.bar(x, views)

    for i, m in enumerate(months):
        print(f"{i}: {m}")

    plt.show()



def strip_query_from_paths(rows, key="path"):
    """
    Remove query strings from path-like fields so UTM/fbclid params
    don't clutter the dashboard output.
    """
    for row in rows or []:
        val = row.get(key)
        if isinstance(val, str) and "?" in val:
            row[key] = val.split("?", 1)[0]


def main():
    # Views based on the SQL views you created in D1
    v_posts = run_sql(
        "SELECT path, full_url, events, avg_duration_s, avg_scroll_pct "
        "FROM v_top_posts_by_duration "
        "ORDER BY avg_duration_s DESC "
        "LIMIT 20;"
    )
    v_countries = run_sql(
        "SELECT country, hits "
        "FROM v_top_countries "
        "ORDER BY hits DESC "
        "LIMIT 20;"
    )
    v_referrers = run_sql(
        "SELECT "
        "  COALESCE(referrer, '(none)') AS referrer, "
        "  COUNT(*) AS hits "
        "FROM analytics "
        "WHERE referrer IS NOT NULL "
        "  AND referrer NOT LIKE '%emmr.me%' "  # skip self-referrals
        "GROUP BY referrer "
        "ORDER BY hits DESC "
        "LIMIT 20;"
    )
    v_google = run_sql(
        "SELECT path, full_url, google_clicks "
        "FROM v_google_clicks_by_page "
        "ORDER BY google_clicks DESC "
        "LIMIT 20;"
    )
    v_days = run_sql(
        "SELECT day, views "
        "FROM v_pageviews_by_day "
        "ORDER BY day DESC "
        "LIMIT 30;"
    )

    # Monthly aggregation (all time)
    v_months = run_sql(
        "SELECT "
        "  strftime('%Y-%m', ts/1000, 'unixepoch') AS month, "
        "  COUNT(*) AS views "
        "FROM analytics "
        "WHERE type = 'page_view' "
        "GROUP BY month "
        "ORDER BY month;"
    )

    # KPIs
    strip_query_from_paths(v_posts, "path")
    strip_query_from_paths(v_google, "path")

    total_30_days = sum(int(r.get("views", 0) or 0) for r in v_days)
    unique_countries = len(v_countries)
    total_google = sum(int(r.get("google_clicks", 0) or 0) for r in v_google)

    if v_posts:
        avg_engagement = (
            sum(float(r.get("avg_duration_s", 0) or 0) for r in v_posts)
            / len(v_posts)
        )
    else:
        avg_engagement = 0.0

    print(C_MAGENTA + C_BOLD + "\n=== ANALYTICS DASHBOARD ===\n" + C_RESET)

    # KPI Summary
    print(C_BOLD + "KPI Summary" + C_RESET)
    print(f"{C_GREEN}Total pageviews (last 30d):{C_RESET}  {total_30_days}")
    print(f"{C_GREEN}Unique countries:{C_RESET}            {unique_countries}")
    print(f"{C_GREEN}Google landings (all time):{C_RESET}  {total_google}")
    print(f"{C_GREEN}Avg engagement (top posts):{C_RESET}  {round(avg_engagement, 1)}s\n")

    # Tables
    print_table(
        "Top Posts by Engagement",
        v_posts,
        ["path", "events", "avg_duration_s", "avg_scroll_pct"],
    )

    print_table(
        "Top Countries",
        v_countries,
        ["country", "hits"],
    )

    print_table(
        "Top Referrers",
        v_referrers,
        ["referrer", "hits"],
    )

    print_table(
        "Google Clicks by Page",
        v_google,
        ["path", "google_clicks"],
    )

    print_table(
        "Pageviews by Day (UTC, last 30 days)",
        v_days,
        ["day", "views"],
    )

    # Charts
    # Reverse days for chronological order (oldest -> newest)
    v_days_chrono = list(reversed(v_days))

    print("\n\nDaily Pageviews Plot:\n")
    plot_daily_pageviews(v_days_chrono)

    print("\n\nMonthly Pageviews Plot:\n")
    plot_monthly_pageviews(v_months)


    print()
    print(
        C_DIM
        + "Last updated: "
        + datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        + C_RESET
    )
    print()


if __name__ == "__main__":
    main()
