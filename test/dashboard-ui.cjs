const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

function dashboard(payload) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        value: '', textContent: '', innerHTML: '', hidden: false,
        addEventListener() {}, setAttribute() {}, querySelectorAll() { return []; },
      });
      return elements.get(id);
    },
    querySelectorAll() { return []; },
  };
  const context = vm.createContext({ document, Intl, Date, URL, payload });
  const source = readFileSync(join(__dirname, '../dashboard/app.js'), 'utf8');
  vm.runInContext(source.replace(/\nload\(\);\s*$/, ''), context);
  vm.runInContext('data = payload; render();', context);
  return elements;
}

function emptyData() {
  return {
    days: 7, updated: '2026-11-12T12:00:00Z', database: 'DB',
    summary: [], daily: [], pages: [], sources: [], countries: [], devices: [],
    campaigns: [], alerts: [], security_summary: [], traffic_quality: [],
  };
}

test('a single suspicious event is a visible priority and paths are escaped', () => {
  const data = emptyData();
  data.alerts = [{ path: '/.env.bak<script>', reason: 'Sensitive file probe', events: 1, last_seen: 1794484800000 }];
  data.security_summary = [{ events: 1, paths: 1 }];
  data.traffic_quality = [{ recorded: 6, suspicious: 1, crawlers: 5, unknown_agent: 0 }];
  const ui = dashboard(data);
  assert.equal(ui.get('security-alert').hidden, false);
  assert.match(ui.get('security-status').textContent, /1 flagged events/);
  assert.match(ui.get('security-rows').innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(ui.get('security-rows').innerHTML, /<script>/);
  assert.match(ui.get('insights').innerHTML, /SECURITY \/ REVIEW NOW/);
  assert.doesNotMatch(ui.get('security-rows').innerHTML, /Limited sample/);
  assert.match(ui.get('traffic-filter').textContent, /5 other crawler-claimed/);
});

test('an empty security result does not claim the site is safe', () => {
  const ui = dashboard(emptyData());
  assert.equal(ui.get('security-alert').hidden, true);
  assert.match(ui.get('security-rows').innerHTML, /does not verify site security/);
  assert.match(ui.get('kpis').innerHTML, /Audience pageviews/);
});
