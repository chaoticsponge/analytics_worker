const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const vm = require('node:vm');

function tracker(options = {}) {
  let clock = 0, interval;
  const events = new Map(), requests = [], storage = new Map();
  const listen = (name, callback) => {
    if (!events.has(name)) events.set(name, []);
    events.get(name).push(callback);
  };
  const document = {
    currentScript: { dataset: { endpoint: 'https://collector.example/analytics', ...options.dataset } },
    visibilityState: 'visible', referrer: 'https://www.google.com/search?q=private',
    documentElement: { scrollHeight: 1600 }, addEventListener: listen,
  };
  const window = { scrollY: 0, innerHeight: 800, innerWidth: 400, addEventListener: listen };
  class ClockDate extends Date { static now() { return 1794484800000 + clock; } }
  const context = vm.createContext({
    document, window, navigator: { platform: 'MacIntel', maxTouchPoints: 0, ...options.navigator },
    location: { href: 'https://example.com/account/private?secret=1', pathname: options.path || '/account/private', search: '?utm_source=newsletter&token=private' },
    URL, URLSearchParams, Date: ClockDate, performance: { now: () => clock }, crypto: { randomUUID },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    fetch: (url, settings) => { requests.push({ url, ...settings, payload: JSON.parse(settings.body) }); return Promise.resolve(); },
    setInterval: callback => { interval = callback; },
  });
  vm.runInContext(readFileSync(join(__dirname, '../SAMPLE_ANALYTICS.js'), 'utf8'), context);
  return { document, requests, storage,
    advance(ms) { clock += ms; }, tick() { interval?.(); },
    dispatch(name) { for (const callback of events.get(name) || []) callback({ persisted: false }); },
  };
}

test('initial view uses a public page key and a random browser ID without URL secrets', () => {
  const state = tracker({ dataset: { page: '/about' } });
  const [request] = state.requests;
  assert.equal(request.payload.path, '/about');
  assert.equal(request.payload.scroll_pct, 50);
  assert.equal(request.payload.active_ms, 0);
  assert.equal(request.payload.visit_id, undefined);
  assert.equal(request.payload.referrer, 'https://www.google.com');
  assert.equal(request.payload.utm_source, null);
  assert.equal(request.credentials, 'omit');
  assert.equal(request.referrerPolicy, 'no-referrer');
  assert.equal(state.storage.size, 1);
  assert.match(request.payload.visitor_id, /^[a-f0-9-]{36}$/);
  assert.doesNotMatch(request.body, /private|user_agent|full_url|session_id/);
  assert.equal(tracker().requests[0].payload.path, '/[unlisted]');
});

test('hidden time is excluded and repeat updates keep the same pageview ID', () => {
  const state = tracker();
  state.advance(10000);
  state.document.visibilityState = 'hidden'; state.dispatch('visibilitychange');
  assert.equal(state.requests.at(-1).payload.active_ms, 10000);
  state.advance(30000);
  state.document.visibilityState = 'visible'; state.dispatch('visibilitychange');
  assert.equal(state.requests.at(-1).payload.active_ms, 10000);
  state.advance(5000); state.tick();
  assert.equal(state.requests.at(-1).payload.active_ms, 15000);
  assert.equal(new Set(state.requests.map(r => r.payload.event_id)).size, 1);
});

test('time stops after inactivity and resumes on interaction', () => {
  const state = tracker();
  for (let i=0; i<8; i++) { state.advance(15000); state.tick(); }
  assert.equal(state.requests.at(-1).payload.active_ms, 60000);
  state.dispatch('keydown'); state.advance(15000); state.tick();
  assert.equal(state.requests.at(-1).payload.active_ms, 75000);
});

test('GPC and DNT suppress all collection and storage', () => {
  for (const navigator of [{ globalPrivacyControl: true }, { doNotTrack: '1' }]) {
    const state = tracker({ navigator, dataset: { trackVisits: 'true' } });
    state.advance(15000); state.tick();
    assert.equal(state.requests.length, 0);
    assert.equal(state.storage.size, 0);
  }
});

test('navigation keeps the browser ID and uses a fresh pageview ID', () => {
  const state = tracker();
  const first = state.requests[0].payload;
  state.advance(10000); state.dispatch('analytics:navigate');
  const next = state.requests.at(-1).payload;
  assert.notEqual(first.event_id, next.event_id);
  assert.equal(next.visit_id, undefined);
  assert.equal(next.visitor_id, first.visitor_id);
  assert.equal(state.storage.size, 1);
});

test('browser IDs expire after 90 days and tracking can be disabled', () => {
  const state = tracker();
  const first = state.requests[0].payload.visitor_id;
  state.advance(91 * 86400000); state.dispatch('analytics:navigate');
  assert.notEqual(state.requests.at(-1).payload.visitor_id, first);
  const disabled = tracker({ dataset: { trackVisitors: 'false' } });
  assert.equal(disabled.requests[0].payload.visitor_id, null);
  assert.equal(disabled.storage.size, 0);
});

test('suspicious fallback paths produce fixed alerts without revealing private prefixes', () => {
  for (const [path, expected] of [['/private/%2eenv.bak', '/.env'], ['/app/config/private-user', '/app/config/']]) {
    const state = tracker({ path, dataset: { page: '/about' } });
    assert.equal(state.requests[0].payload.path, expected);
    assert.doesNotMatch(state.requests[0].body, /private-user|private\//);
  }
});
