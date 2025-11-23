# Cloudflare Analytics Worker (Workers + D1)

Simple, privacy-friendly website analytics built entirely on Cloudflare:

- Cloudflare Worker receives browser events on `POST /analytics`
- Events are stored in a Cloudflare D1 database you control
- Frontend script (`analytics.js`) tracks page views, time on page, scroll depth, basic device info, and UTM parameters.

No external databases, no third-party trackers, away from googles AD network and completely free for small use-cases like my hobby site.

## Quick start

```bash
git clone https://github.com/<yourname>/emstat-analytics
cd emstat-analytics

npm install -g wrangler
wrangler login

# create your own D1 database (returns database_id)
wrangler d1 create <your-database-name>

# update wrangler.jsonc with your database name and id

# apply the SQL migration
wrangler d1 migrations apply <your-database-name>

# deploy to your own Worker
wrangler deploy
```

## Configure it for your domain

- In `src/index.js`, set `ALLOWED_ORIGINS` to the origins that can send analytics data.
- In `SAMPLE_ANALYTICS.js`, set `ANALYTICS_URL` to **your** Worker endpoint, e.g. `https://<your-worker>.workers.dev/analytics` or `/analytics` if you bind a custom domain.
- In `wrangler.jsonc`, replace the D1 placeholders with your own `database_name` and `database_id`.
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
