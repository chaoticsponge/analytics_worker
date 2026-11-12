#!/usr/bin/env python3
"""Fetch D1 analytics and serve a private, dependency-free local dashboard."""
import argparse
import json
import os
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import shutil
import subprocess
import threading
from urllib.parse import parse_qs, urlsplit
import webbrowser

ROOT = Path(__file__).resolve().parent
DB_NAME = "DB"  # Wrangler D1 binding name
CRAWLER_TOKENS = json.loads((ROOT / 'crawler_tokens.json').read_text())
PROBE_RULES = {
    'Sensitive file probe': ('*/.env', '*/.env.*', '*/.env/*', '*/.env~',
                             '*/.git', '*/.git/*', '*/.svn/*', '*/.aws/credentials',
                             '*/wp-config.php*', '/etc/passwd', '*/.ssh/*'),
    'Configuration probe': ('/app/config', '/app/config/*', '/config.json',
                            '/config.php', '/config.yml', '/config.yaml'),
    'Traversal probe': ('*/../*', '*/..'),
    'Admin/debug probe': ('/phpmyadmin', '/phpmyadmin/*', '/server-status',
                          '/actuator/env', '/actuator/heapdump', '/debug/default/*'),
}


def queries(days, now=None, visitor_schema=False):
    now = now or datetime.now(timezone.utc)
    end = int(now.timestamp() * 1000)
    start = int((now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days - 1)).timestamp() * 1000)
    previous = start - (end - start)
    window = f"type = 'page_view' AND ts >= {start} AND ts < {end}"
    path = "COALESCE(NULLIF(CASE WHEN instr(path, '?') > 0 THEN substr(path, 1, instr(path, '?') - 1) ELSE path END, ''), '(unknown)')"
    metrics = "COUNT(*) AS views, AVG(CASE WHEN duration_ms >= 0 THEN duration_ms / 1000.0 END) AS duration, AVG(CASE WHEN scroll_pct BETWEEN 0 AND 100 THEN scroll_pct END) AS scroll"
    decoded = f"lower({path})"
    # Decode common scanner encodings; this is a heuristic, not a URL parser/WAF.
    for _ in range(2):
        for encoded, literal in (('%25', '%'), ('%2e', '.'), ('%2f', '/'), ('%5c', '/')):
            decoded = f"replace({decoded}, '{encoded}', '{literal}')"
    decoded = f"replace({decoded}, char(92), '/')"
    rules = ' '.join(
        "WHEN (" + ' OR '.join(f"normalized_path GLOB '{pattern}'" for pattern in patterns)
        + f") THEN '{reason}'" for reason, patterns in PROBE_RULES.items()
    )
    crawler = "COALESCE(device_type, '') = 'bot' OR " + ' OR '.join(f"instr(lower(COALESCE(user_agent, '')), '{token}') > 0" for token in CRAWLER_TOKENS)
    crawler_name = "CASE " + ' '.join(
        f"WHEN instr(lower(COALESCE(user_agent, '')), '{token}') > 0 THEN '{token}'" for token in CRAWLER_TOKENS
    ) + " ELSE NULL END"
    if visitor_schema:
        crawler_name = f"COALESCE(bot_name, {crawler_name})"
    visitor_key = "'legacy:' || NULLIF(session_id, '')"
    if visitor_schema:
        visitor_key = "COALESCE('v2:' || NULLIF(visitor_id, ''), 'legacy:' || NULLIF(session_id, ''))"
    prefix = (
        f"WITH normalized AS (SELECT *, {decoded} AS normalized_path, {visitor_key} AS visitor_key, {crawler_name} AS crawler_name FROM analytics WHERE ts >= {previous} AND ts < {end}), "
        f"classified AS (SELECT *, CASE {rules} ELSE NULL END AS reason, ({crawler}) AS crawler FROM normalized), "
        "audience AS (SELECT * FROM classified WHERE reason IS NULL AND NOT crawler) "
    )
    statements = {
        "summary": f"SELECT CASE WHEN ts >= {start} THEN 'current' ELSE 'previous' END AS period, {metrics}, COUNT(DISTINCT NULLIF(session_id, '')) AS browsers, COUNT(DISTINCT CASE WHEN {path} != '/[unlisted]' THEN {path} END) AS pages, COUNT(DISTINCT NULLIF(country, '')) AS countries, SUM(CASE WHEN duration_ms >= 0 THEN 1 ELSE 0 END) AS duration_samples, SUM(CASE WHEN scroll_pct BETWEEN 0 AND 100 THEN 1 ELSE 0 END) AS scroll_samples, SUM(CASE WHEN visitor_key IS NOT NULL THEN 1 ELSE 0 END) AS identified, SUM(CASE WHEN NULLIF(utm_source, '') IS NOT NULL THEN 1 ELSE 0 END) AS tagged FROM audience WHERE type = 'page_view' AND ts >= {previous} AND ts < {end} GROUP BY period",
        "daily": f"SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day, COUNT(*) AS views FROM audience WHERE {window} GROUP BY day ORDER BY day",
        "pages": f"SELECT {path} AS path, {metrics}, SUM(CASE WHEN duration_ms >= 0 AND scroll_pct BETWEEN 0 AND 100 THEN 1 ELSE 0 END) AS measured FROM audience WHERE {window} GROUP BY 1 ORDER BY views DESC LIMIT 100",
        "sources": f"SELECT COALESCE(NULLIF(utm_source, ''), NULLIF(referrer, ''), '(direct / unknown)') AS label, {metrics} FROM audience WHERE {window} GROUP BY 1 ORDER BY views DESC LIMIT 100",
        "countries": f"SELECT COALESCE(NULLIF(country, ''), '(unknown)') AS label, COUNT(*) AS views FROM audience WHERE {window} GROUP BY 1 ORDER BY views DESC LIMIT 20",
        "devices": f"SELECT COALESCE(NULLIF(device_type, ''), '(unknown)') AS label, {metrics} FROM audience WHERE {window} GROUP BY 1 ORDER BY views DESC",
        "campaigns": f"SELECT COALESCE(NULLIF(utm_campaign, ''), '(no campaign)') AS label, {metrics} FROM audience WHERE {window} AND NULLIF(utm_source, '') IS NOT NULL GROUP BY 1 ORDER BY views DESC LIMIT 20",
    }
    statements = {key: prefix + sql for key, sql in statements.items()}
    statements['alerts'] = prefix + (
        f"SELECT {path} AS path, reason, COALESCE(NULLIF(ip, ''), '(not recorded / expired)') AS ip, COUNT(*) AS events, MAX(ts) AS last_seen "
        f"FROM classified WHERE ts >= {start} AND reason IS NOT NULL "
        "GROUP BY 1, 2, 3 ORDER BY events DESC, last_seen DESC LIMIT 100"
    )
    statements['traffic_quality'] = prefix + (
        "SELECT COUNT(*) AS recorded, "
        "SUM(CASE WHEN reason IS NOT NULL THEN 1 ELSE 0 END) AS suspicious, "
        "SUM(CASE WHEN reason IS NULL AND crawler THEN 1 ELSE 0 END) AS crawlers, "
        "SUM(CASE WHEN reason IS NULL AND NOT crawler AND NULLIF(trim(user_agent), '') IS NULL THEN 1 ELSE 0 END) AS unknown_agent "
        f"FROM classified WHERE ts >= {start} AND type = 'page_view' GROUP BY 'current'"
    )
    statements['security_summary'] = prefix + (
        f"SELECT COUNT(*) AS events, COUNT(DISTINCT {path}) AS paths "
        f"FROM classified WHERE ts >= {start} AND reason IS NOT NULL GROUP BY 'current'"
    )
    history_key = visitor_key.replace('visitor_id', 'a.visitor_id').replace('session_id', 'a.session_id')
    first_seen = 'a.ts'
    join = ''
    if visitor_schema:
        first_seen = 'COALESCE(v.first_seen, a.ts)'
        join = 'LEFT JOIN visitors v ON v.visitor_id = a.visitor_id'
    statements['visitor_summary'] = prefix.rstrip() + (
        f", history AS (SELECT {history_key} AS visitor_key, MIN({first_seen}) AS first_seen "
        f"FROM analytics a {join} WHERE a.ts < {end} GROUP BY 1), "
        f"browser_periods AS (SELECT CASE WHEN ts >= {start} THEN 'current' ELSE 'previous' END AS period, "
        "audience.visitor_key, MIN(history.first_seen) AS first_seen FROM audience "
        f"JOIN history ON history.visitor_key = audience.visitor_key WHERE type = 'page_view' "
        "GROUP BY 1, 2) SELECT period, COUNT(*) AS unique_browsers, "
        f"SUM(CASE WHEN first_seen >= CASE period WHEN 'current' THEN {start} ELSE {previous} END THEN 1 ELSE 0 END) AS new_browsers, "
        f"SUM(CASE WHEN first_seen < CASE period WHEN 'current' THEN {start} ELSE {previous} END THEN 1 ELSE 0 END) AS returning_browsers "
        "FROM browser_periods GROUP BY period"
    )
    statements['security_ips'] = prefix + (
        "SELECT ip, COUNT(*) AS events, "
        "SUM(CASE WHEN reason IS NOT NULL THEN 1 ELSE 0 END) AS suspicious, "
        "SUM(CASE WHEN reason IS NULL AND crawler THEN 1 ELSE 0 END) AS crawlers, GROUP_CONCAT(DISTINCT crawler_name) AS crawler_claims, MAX(ts) AS last_seen "
        f"FROM classified WHERE ts >= {start} AND NULLIF(ip, '') IS NOT NULL AND (reason IS NOT NULL OR crawler) "
        "GROUP BY ip ORDER BY suspicious DESC, events DESC LIMIT 100"
    )
    return statements


def execute_sql(sql, database):
    wrangler = ROOT / 'node_modules' / '.bin' / 'wrangler'
    executable = shutil.which('wrangler')
    if not executable and os.access(wrangler, os.X_OK):
        executable = str(wrangler)
    if not executable:
        raise RuntimeError('Wrangler is missing. Run npm install, then wrangler login.')
    try:
        result = subprocess.run([executable, 'd1', 'execute', database, '--remote', '--command', sql, '--json'], cwd=ROOT, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError('D1 did not respond within 120 seconds. Check your connection and retry.') from exc
    if result.returncode:
        raise RuntimeError('D1 query failed. Check your Wrangler login and database configuration.')
    try:
        results = json.loads(result.stdout)
        if not isinstance(results, list) or not results:
            raise ValueError('Missing query results')
        if any(item.get('success') is False or not isinstance(item.get('results'), list) for item in results):
            raise ValueError('Unsuccessful query')
    except (ValueError, TypeError, AttributeError) as exc:
        raise RuntimeError('Wrangler returned an unexpected response; update Wrangler and retry.') from exc
    return results


def collect(days, database):
    columns = execute_sql("SELECT name FROM pragma_table_info('analytics');", database)[0]['results']
    visitor_schema = any(column['name'] == 'visitor_id' for column in columns)
    statements = queries(days, visitor_schema=visitor_schema)
    results = execute_sql(';\n'.join(statements.values()) + ';', database)
    if len(results) != len(statements):
        raise RuntimeError('Wrangler returned an unexpected number of query results.')
    data = {key: item['results'] for key, item in zip(statements, results)}
    return {**data, 'days': days, 'updated': datetime.now(timezone.utc).isoformat(), 'database': database}


def make_handler(database, cache):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            # Reject cross-origin reads and DNS rebinding, even on loopback.
            address = f'127.0.0.1:{self.server.server_port}'
            if self.headers.get('Host') != address or self.headers.get('Origin') not in (None, f'http://{address}') or self.headers.get('Sec-Fetch-Site') == 'cross-site':
                self.respond(403, b'Forbidden', 'text/plain')
                return
            url = urlsplit(self.path)
            if url.path == '/api/data':
                params = parse_qs(url.query)
                try:
                    days = int(params.get('days', ['30'])[0])
                    if days not in (7, 30, 90):
                        raise ValueError()
                except ValueError:
                    self.respond(400, b'{"error":"Choose 7, 30, or 90 days."}', 'application/json')
                    return
                try:
                    if days not in cache or params.get('refresh') == ['1']:
                        cache[days] = collect(days, database)
                    self.respond(200, json.dumps(cache[days]).encode(), 'application/json')
                except (RuntimeError, OSError) as exc:
                    print(f'Analytics: {exc}', flush=True)
                    self.respond(502, json.dumps({'error': str(exc)}).encode(), 'application/json')
                return
            assets = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'), '/style.css': ('style.css', 'text/css')}
            if url.path not in assets:
                self.respond(404, b'Not found', 'text/plain')
                return
            filename, content_type = assets[url.path]
            self.respond(200, (ROOT / 'dashboard' / filename).read_bytes(), content_type)

        def respond(self, status, body, content_type):
            self.send_response(status)
            self.send_header('Content-Type', content_type + '; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', default=DB_NAME)
    parser.add_argument('--port', type=int, default=8765, help='Local HTTP port (0 selects an available port)')
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    cache = {}
    try:
        server = HTTPServer(('127.0.0.1', args.port), make_handler(args.database, cache))
    except OSError as exc:
        parser.exit(1, f'Cannot start dashboard: {exc}. Try --port 0.\n')
    print('Fetching analytics from D1…', flush=True)
    try:
        cache[30] = collect(30, args.database)
    except (RuntimeError, OSError) as exc:
        print(f'{exc} You can retry from the dashboard.', flush=True)
    url = f'http://127.0.0.1:{server.server_port}'
    print(f'Dashboard: {url}\nPress Ctrl+C to stop.', flush=True)
    if not args.no_browser:
        threading.Timer(0.3, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nDashboard stopped.')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
