# Cloudflare Analytics Worker (Workers + D1)

Simple, privacy-friendly website analytics built entirely on Cloudflare:

- Cloudflare Worker receives browser events on `POST /analytics`
- Events are stored in a Cloudflare D1 database you control
- Frontend script (`analytics.js`) tracks page views, time on page, scroll depth, basic device info, and UTM parameters.

No external database or third-party analytics service is required.

## Local analytics dashboard

Run with Python 3.9+ and Node.js / Wrangler installed and authenticated:

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc
# Fill in your database ID, database name, and allowed website origins.
npx wrangler login
python3 analytics.py
# or: npm run dashboard
```

The script fetches aggregated data from remote D1, starts an HTTP server at
http://127.0.0.1:8765, and opens your browser. Keep the terminal running;
Ctrl+C stops the server. No Python packages or frontend build are needed.
The dashboard uses the base `analytics` table, so custom SQL views are unnecessary.

```bash
python3 analytics.py --database DB --port 8765
python3 analytics.py --port 0        # choose an available port
python3 analytics.py --no-browser   # print the URL without opening it
```

Choose 7, 30, or 90 days. Each range is fetched once per run; **Refresh data**
queries D1 again. Requests only read aggregates; they never write analytics or
expose credentials, raw IPs, or browser IDs to the webpage. The server binds only
to loopback and serves an explicit asset allowlist. Nothing is published.
Connection failures appear in the dashboard and can be retried.

The interface includes daily traffic, comparison metrics, sortable/searchable
page engagement, acquisition, devices, geography, campaigns, recommended actions,
and a collection audit. Dates use UTC, include partial today, and compare with an
immediately preceding window of equal duration. Missing chart dates appear as
zero recorded views; this does not verify that collection was working.

### How to interpret the data

- Counts include only `page_view` events. Query strings are combined before page
  aggregation. Rankings are capped: 100 pages/sources and 20 countries/campaigns;
  headline totals query the full date range. Breakdown charts show six entries.
  Audience metrics consistently exclude recognized crawler user-agent claims and
  suspicious paths in both current and comparison periods.
- Recognized browsers count distinct stored `session_id` values. The sample uses
  persistent localStorage IDs; these are neither actual visits nor unique people.
- Time is average elapsed time where nonnegative, and may include background tabs.
  Scroll is average maximum depth in the valid 0–100 range, not a completion rate.
  Coverage reports field presence/validity, not collection accuracy.
- Page recommendations require at least 20 views and 20 paired time/scroll
  measurements. Scroll below 40% prompts review; scroll at least 70% with at least
  30 seconds suggests engagement. These are transparent heuristics, not statistical
  significance or proof of success. Security alerts have no minimum sample size.
- Sources prefer UTM source, otherwise referrer host. Direct/unknown and
  self-referrals are included. Referrers are not Search Console clicks.

### Data needed for clearer outcomes

1. **Conversion goals:** named signup/contact/download/click outcomes with a page
   and campaign reference, so success can be measured beyond traffic.
2. **Real visit and event IDs:** inactivity-based visits and deduplicated events
   for funnels and visit-level engagement. Avoid calling persistent browser IDs sessions.
3. **Reliable attention:** initial pageviews plus deduplicated updates, active
   visible time, and initial scroll depth. The sample currently sends once when
   first hidden; later reading is missed, and unscrolled pages report zero depth.
4. **Search and experience:** Search Console impressions/position/clicks, Core Web
   Vitals, and errors to help explain acquisition and engagement changes.

The audit is included in the GUI. Collection behavior is unchanged by this
local dashboard. Before extending tracking, review raw IP/user-agent retention,
sensitive URL parameters, and bot filtering in the existing collector.

Run dashboard checks with:

```bash
python3 -m unittest discover -s test -p 'test_*.py' -v
node --test test/dashboard-ui.cjs
npm test -- --run
```

## Suspicious paths and crawler filtering

A separate **Security alerts** panel flags even one recorded event targeting
sensitive files (such as `/.env.bak` or `/.git/config`), `/app/config/`, common
admin/debug probes, and traversal patterns. Case and common encoded dot/slash
variants are handled. Rules are defined in `PROBE_RULES` in `analytics.py`.
These are possible probes, not proof of compromise; legitimate application
routes may also match. Review origin access logs, HTTP response status, and WAF
events to determine what happened.

Security alerts query all recorded event types independently of the top-content
limit. The panel shows the top 100 path/rule groups, with an uncapped event total.
Suspicious paths remain visible here even when the sender claims to be Googlebot.
They are excluded from content engagement recommendations and audience metrics.

Known search, indexing, SEO, AI, and preview crawler user-agent tokens in
`CRAWLER_TOKENS` are excluded from every audience query, including comparisons.
Exclusion counts are visible; suspicious pageviews and other crawler pageviews
are counted separately without double counting. Raw D1 records are retained.
This does not block crawling or change search indexing.

User-agent strings are self-reported and can be spoofed. This is heuristic
filtering, not verified human/bot classification. Missing user agents remain in
audience metrics with an explicit count. For stronger attribution, collect
verified bot signals at the **website's edge**, rather than trusting the browser
payload or the user agent of a beacon POST. See [Google's verification guidance](https://developers.google.com/search/docs/crawling-indexing/googlebot)
and [Cloudflare bot signals](https://developers.cloudflare.com/bots/reference/bot-management-variables/).

Browser analytics only sees events that reach the collector. Scanners that never
execute JavaScript will be missing; complete security visibility needs website
access/WAF logs with requested paths, response statuses, and mitigation actions.
Refreshing or restarting the dashboard applies these rules to historical records;
no schema migration or Worker redeployment is needed.

## Quick start

```bash
git clone <your-repository-url>
cd <repository-directory>

npm install
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler login

# create your own D1 database (returns database_id)
npx wrangler d1 create <your-database-name>

# update wrangler.jsonc with your database name and id

# apply the SQL migration
npx wrangler d1 migrations apply DB --remote

# deploy to your own Worker
npm run deploy
```

## Configure it for your domain

- In your ignored `wrangler.jsonc`, set `vars.ALLOWED_ORIGINS` to a comma-separated list of exact website origins that can send analytics data.
- In `SAMPLE_ANALYTICS.js`, set `ANALYTICS_URL` to **your** Worker endpoint, e.g. `https://<your-worker>.workers.dev/analytics` or `/analytics` if you bind a custom domain.
- Copy `wrangler.example.jsonc` to `wrangler.jsonc` and replace the D1 placeholders with your own `database_name` and `database_id`. Keep the binding named `DB`; both Python tools use it by default.
- `wrangler.jsonc` is intentionally ignored. Never commit it, credentials, analytics exports, or screenshots containing real traffic data.
- Move `SAMPLE_ANALYTICS.js` into your site (e.g., `/js/analytics.js`) and include it on the pages you want to track:
  ```html
  <script src="/js/analytics.js"></script>
  ```

## D1 schema

`migrations/0001_create_analytics.sql`:

```sql
CREATE TABLE IF NOT EXISTS analytics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT,
  path TEXT,
  full_url TEXT,
  referrer TEXT,
  user_agent TEXT,
  duration_ms INTEGER,
  scroll_pct INTEGER,
  session_id TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  device_type TEXT,
  device_os TEXT,
  device_browser TEXT,
  ip TEXT,
  country TEXT,
  city TEXT,
  colo TEXT
);
```
