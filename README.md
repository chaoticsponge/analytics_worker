# Cloudflare Analytics Worker + local dashboard

Self-hosted website analytics using a Cloudflare Worker, D1, and a local Python
dashboard. The v2 collector measures content performance and estimates returning
browsers using random IDs, with short-lived IP logs for security review.

## What the minimal setup measures

- Pageviews for explicitly approved public page names.
- Coarse device, OS, and browser categories; unknown devices stay unknown.
- A broad viewport category: small, medium, or large.
- Approximate visible reading time, stopping after 60 seconds without interaction.
- Maximum scroll depth, including the initial viewport.
- Approved referral hostnames; other referrals become one generic category.
- Possible sensitive-path probes, stored as fixed categories.

The default configuration stores a random browser ID in localStorage for **90
days**, and a network IP in D1 for **7 days** for security review. This is
pseudonymous analytics, not anonymous analytics. It uses no cookies, raw stored
user-agent strings, full URLs, cities, or IP-based fingerprints. Each pageview
also has a separate in-memory random ID so cumulative updates and retries update
one row instead of adding views. There are no session/visit IDs.

The dashboard reports **unique browsers**, with **new + returning = unique** for
the selected window. New means first observed within that window; returning means
first observed before it. First-seen history is retained separately from event
rows. These are browser estimates, not verified people: storage deletion, another
device/browser, private browsing, ID expiry, and the v2 upgrade can create a new
identity. Browsers blocking storage are excluded from unique counts, but their
pageviews still count. Bots that look human can remain in estimates.

GPC and Do Not Track suppress collection. Requests omit credentials and the HTTP
Referer header. The Worker briefly processes the request user agent to derive
coarse categories, but never writes or logs it. Cloudflare still receives network
metadata while handling HTTP requests; this code does not control platform logs
or backups. Data minimization is not a guarantee that every jurisdiction permits
analytics without consent. No consent popup is implemented by this repository;
that is not a compliance guarantee. Review your obligations and disclose browser
ID/IP collection in your privacy notice. The [UAE government describes the UAE's
personal-data protection framework](https://u.ae/en/about-the-uae/digital-uae/data/data-protection-laws);
being based in Dubai does not by itself establish an exemption.

## Fresh installation

Requirements: Node.js compatible with Wrangler, Python 3.9+, and a Cloudflare account.

```bash
npm ci
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler login
npx wrangler d1 create <your-database-name>
```

Edit your ignored `wrangler.jsonc`:

- Set the Worker `name`, D1 `database_name`, and returned `database_id`.
- Set `ALLOWED_ORIGINS` to exact website origins, separated by commas.
- Set `PUBLIC_PATHS` to the public page names you want to measure, separated by
  commas. Use a fixed route name such as `/article/:slug` where a real path might
  contain private information. Never allowlist personal account paths or tokens.
- Set `REFERRER_HOSTS` to approved public referrer hostnames.
- `TRACK_VISITORS` defaults to `true`. To disable browser tracking, set it to
  `false` **and** add `data-track-visitors="false"` to the website script tag.
- `LOG_IPS` defaults to `true`. IPs come only from Cloudflare's connecting-IP
  header, never from the client payload or X-Forwarded-For. Set to `false` to stop
  new IP collection. IPs do not reliably identify a person (NAT/VPNs/shared networks).
- `IP_RETENTION_DAYS` defaults to 7, valid range 1–30. Daily cleanup clears IPs
  from older versioned rows while retaining their aggregate measurement fields.
- `COLLECT_COUNTRY` defaults to `false`; if enabled, only the country code is stored.
- Campaign collection is disabled unless you explicitly configure
  `CAMPAIGN_SOURCES` and `CAMPAIGN_NAMES` and enable it in the script tag. Only
  exact allowlisted values are stored. Search terms and free-form UTM values are
  not stored.
- `RETENTION_DAYS` defaults to 90, with a daily cleanup at 03:00 UTC. This deletes
  expired rows written by the new collector (versions 1 and 2), not historical
  unversioned rows. Visitor metadata expires after 90 days without
  a recorded activity. Cleanup happens on the next scheduled run, so removal can
  lag by a day. Valid event-retention settings are 7–365 days. Short retention
  means longer comparison windows may have incomplete baselines.

Then apply both migrations before deploying:

```bash
npx wrangler d1 migrations apply DB --remote
npm run deploy
```

Copy `SAMPLE_ANALYTICS.js` into your website as `/js/analytics.js`. On each public
page, use its approved name and your Worker endpoint:

```html
<script src="/js/analytics.js"
        data-endpoint="https://your-worker.workers.dev/analytics"
        data-page="/about" defer></script>
```

`data-page` must match `PUBLIC_PATHS` exactly. If missing or unapproved, it is
counted as `/[unlisted]`. The script **never sends the raw current URL
path, query string, or fragment**. This prevents accidental collection of account
names, search terms, and token-bearing URLs. Set the public name in your template;
there is no visitor popup added by this code. Known suspicious paths are detected
locally and sent as fixed categories even if the page uses a public fallback
name. Arbitrary requested paths are not transmitted.

For a single-page app, update the script's `data-page` to the new public route
name and dispatch `window.dispatchEvent(new Event('analytics:navigate'))` after
each navigation. The old view is flushed before a new pageview starts.

To attribute a controlled campaign, add `data-campaigns="true"` to the script tag
and use only public, nonpersonal values in `utm_source` and `utm_campaign`.

## Upgrade an existing installation

1. Keep your local `wrangler.jsonc`; **do not replace it** with the example.
   Add the new variables and daily cron trigger from `wrangler.example.jsonc`.
   The Worker requires `ALLOWED_ORIGINS`. Only `/` is approved if `PUBLIC_PATHS`
   is omitted.
2. Apply `0002_privacy_events.sql` through Wrangler migrations before deploying
   the Worker. If your existing table was created manually and migration 0001 is
   unrecorded, review Wrangler's migration plan: 0001 uses `IF NOT EXISTS` and
   can run against the existing table. Never run the ALTER statements twice.
3. Deploy the Worker, then replace the website tracker and script tags promptly.
   The new Worker accepts cached legacy payloads during rollout, marking them as
   version 1 with elapsed-time measurements. Replace the tracker to get v2
   active-time updates, deduplication, and expiring browser IDs.
4. Clear any website/CDN cache for the tracker and test from a phone and computer.
   In the browser Network panel, successful POSTs return 204. Repeated updates
   for one page have the same event ID and produce one D1 row.
5. Restart the local dashboard. It supports legacy and v2 rows, but legacy elapsed
   time and v2 active time are different measurements. Compare like-for-like
   periods when assessing changes after deployment.

The upgrade is additive and does not rewrite historical records. **Old IPs,
user agents, URLs, cities, and persistent IDs remain in existing rows.** Review
those separately before deciding to redact or delete them. The new collector
uses a new expiring browser-ID key and does not reuse old localStorage IDs.
Unique/returning counts are based on available history; upgrading resets browser
identity, so comparisons spanning the rollout need care.

Origin checks and payload validation are not bot authentication: non-browser
clients can forge an Origin and user-agent. Configure Cloudflare request rate
limits for the public collector to contain write abuse; do not put a shared
"secret" in browser JavaScript and treat it as access control.

The repository contains examples only. `wrangler.jsonc`, `.env*`, `.dev.vars*`,
Wrangler state, and editor artifacts are ignored. Do not commit real analytics
exports, screenshots, credentials, or personal configuration.

## Local dashboard

```bash
python3 analytics.py
# or: npm run dashboard
python3 analytics.py --database DB --port 8765
python3 analytics.py --port 0       # choose an available port
python3 analytics.py --no-browser
```

The script fetches read-only remote D1 aggregates and opens
http://127.0.0.1:8765. Keep the terminal running; Ctrl+C stops it.
There are no Python dependencies, frontend build, or external dashboard services.
Custom SQL views are unnecessary. `d1logs.py` is an optional terminal diagnostic.

Choose 7, 30, or 90 days. Each range is cached for the run; **Refresh data** queries
D1 again. Dates use UTC, include partial today, and compare with an immediately
preceding window of equal duration. Empty days mean zero recorded views, not
verified collection uptime. Rankings show 100 pages/sources and 20
countries/campaigns; charts show six entries. Headline totals are uncapped.

The dashboard includes traffic, unique browsers, the new/returning split,
searchable/sortable content performance, acquisition, devices, geography,
campaigns, security alerts, and a measurement audit. It does not claim verified
unique people or report visits/bounce rate. It detects the schema and also works
against the legacy table before migration.

Security alerts include IPs, plus an **IPs to review** table separating possible
probes from named crawler claims (such as Googlebot), without storing full user
agents. These names are claims, not verified identities. Top 100 IPs and path/rule/IP groups are displayed.
These are for investigation, not automatic blocking: shared IPs can include real
visitors, and crawler claims can include legitimate search indexing. Confirm with
website/WAF logs before blocking. The local API includes these IPs and must remain
bound to loopback; never publish analytics snapshots or expose it publicly.

## Suspicious paths and crawler filtering

Security alerts trigger on even one recorded event matching `PROBE_RULES` in
`analytics.py`. The v2 Worker collapses recognized probe paths to fixed examples
such as `/.env` or `/app/config/`, without retaining arbitrary submitted paths.
Alerts show the top 100 path/rule/IP groups across all event types, with an uncapped
event total. A crawler claim never suppresses a suspicious-path alert.

`crawler_tokens.json` is shared by the Worker and dashboard. Recognized crawler
claims are retained as `device_type = 'bot'`, with no stored raw UA. The dashboard
excludes these and suspicious paths from every audience query and comparison,
while reporting disjoint exclusion counts. Legacy records are classified using
their stored UAs. This does not block search indexing.

Classification is heuristic. Missing/unknown signals do not prove human traffic;
Googlebot claims can be spoofed. Browser analytics misses scans that never execute
the tracker. Use website access/WAF logs with requested paths, status, and actions
for fuller security coverage. Verified bot signals belong at the website edge,
not in a trusted browser payload. [Google verification guidance](https://developers.google.com/search/docs/crawling-indexing/googlebot),
[Cloudflare bot signals](https://developers.cloudflare.com/bots/reference/bot-management-variables/).

Page engagement signals require 20 views and 20 valid paired time/scroll samples.
Mean maximum scroll below 40% suggests review; at least 70% with 30 seconds suggests
engagement. These are heuristics, not statistical significance or proof of success.
Active visible time is an approximation, not proof someone read the page.

For clearer outcomes later, add aggregate counts of explicitly named goals such
as a successful contact form or download; never collect form contents. Search Console impressions/clicks and aggregate performance/error
signals can explain traffic and engagement changes without tracking individuals.

## Checks

```bash
npm test -- --run
node --test test/tracker.cjs test/dashboard-ui.cjs
python3 -m unittest discover -s test -p 'test_*.py' -v
```

Worker tests use only the example configuration and an isolated local D1 database.
See `migrations/0001_create_analytics.sql` for the legacy-compatible base schema
and `migrations/0002_privacy_events.sql` for the v2 fields.
