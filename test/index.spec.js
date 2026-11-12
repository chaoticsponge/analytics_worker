import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import worker from '../src';

const origin = 'https://example.com';
const config = { ...env, PUBLIC_PATHS: '/,/about', CAMPAIGN_SOURCES: 'newsletter', CAMPAIGN_NAMES: 'launch' };
const event = values => ({ tracker_version: 2, type: 'page_view', event_id: crypto.randomUUID(), visitor_id: crypto.randomUUID(), path: '/about', active_ms: 0, scroll_pct: 25, ...values });
function post(body, headers = {}, settings = config) {
	return worker.fetch(new Request('https://collector.example/analytics', {
		method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain', ...headers },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	}), settings);
}
async function rows() { return (await env.DB.prepare('SELECT * FROM analytics').all()).results; }
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

describe('Privacy analytics Worker', () => {
	it('returns 404 outside the endpoint', async () => {
		expect((await worker.fetch(new Request('https://collector.example/'), config)).status).toBe(404);
	});
	it('requires an explicit configured Origin including on preflight', async () => {
		for (const value of ['', 'null', 'https://foreign.example']) expect((await post(event(), { Origin: value })).status).toBe(403);
		expect((await post(event(), {}, { ...config, ALLOWED_ORIGINS: '' })).status).toBe(403);
		const response = await worker.fetch(new Request('https://collector.example/analytics', { method: 'OPTIONS', headers: { Origin: origin } }), config);
		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
		expect(response.headers.has('Access-Control-Allow-Credentials')).toBe(false);
	});
	it('honors GPC and DNT before writing data', async () => {
		for (const header of ['Sec-GPC', 'DNT']) expect((await post(event(), { [header]: '1' })).status).toBe(204);
		expect(await rows()).toHaveLength(0);
	});
	it('rejects invalid payloads and oversized streams', async () => {
		for (const body of ['{', null, [], event({ tracker_version: 1 }), event({ event_id: 'invalid' }), event({ active_ms: -1 }), event({ scroll_pct: 101 }), event({ path: 'https://foreign.example' })]) {
			expect((await post(body)).status).toBe(400);
		}
		expect((await post('x'.repeat(4097))).status).toBe(413);
		expect(await rows()).toHaveLength(0);
	});
	it('stores only minimized fields and uses header UA rather than claimed device', async () => {
		const body = event({ path: '/about?email=private@example.test#secret', user_agent: 'private string', ip: '192.0.2.1', full_url: 'https://example.com/private', device_type: 'desktop', referrer: 'https://www.google.com/search?q=private', utm_source: 'newsletter', utm_campaign: 'launch', utm_term: 'private', visit_id: crypto.randomUUID(), viewport_class: 'small' });
		expect((await post(body, { 'CF-Connecting-IP': '192.0.2.9', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18 Mobile/1 Safari/604.1' })).status).toBe(204);
		const [row] = await rows();
		expect(row).toMatchObject({ path: '/about', device_type: 'mobile', device_os: 'iOS', device_browser: 'Safari', viewport_class: 'small', ip: '192.0.2.9', visitor_id: body.visitor_id, referrer: 'www.google.com', utm_source: 'newsletter', utm_campaign: 'launch', tracker_version: 2 });
		for (const field of ['user_agent', 'full_url', 'city', 'colo', 'session_id', 'utm_term', 'utm_content', 'country']) expect(row[field]).toBeNull();
	});
	it('accepts a cached legacy tracker without storing its raw payload fields', async () => {
		const response = await post({ type: 'page_view', path: '/about?private=1', duration_ms: 17000,
			scroll_pct: 20, session_id: 'abcdefghijklmnop1234', full_url: 'https://example.com/about?private=1',
			user_agent: 'private raw UA', ip: '192.0.2.99' }, { 'CF-Connecting-IP': '192.0.2.1' });
		expect(response.status).toBe(204);
		expect((await rows())[0]).toMatchObject({ path: '/about', duration_ms: 17000,
			tracker_version: 1, session_id: 'abcdefghijklmnop1234', visitor_id: null,
			full_url: null, user_agent: null, ip: '192.0.2.1' });
	});
	it('deduplicates out-of-order retries without reducing engagement', async () => {
		const body = event();
		for (const values of [{ active_ms: 20000, scroll_pct: 80 }, { active_ms: 10000, scroll_pct: 40 }, { active_ms: 20000, scroll_pct: 80 }]) {
			expect((await post({ ...body, ...values })).status).toBe(204);
		}
		const result = await rows();
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ duration_ms: 20000, scroll_pct: 80 });
	});
	it('collapses unapproved paths, campaign values, and referrers', async () => {
		await post(event({ path: '/account/private@example.test', referrer: 'https://private.example/path?token=secret', utm_source: 'private@example.test', utm_campaign: 'secret' }));
		expect((await rows())[0]).toMatchObject({ path: '/[unlisted]', referrer: '(other referral)', utm_source: null, utm_campaign: null, device_type: 'unknown' });
	});
	it('keeps canonical security signals for crawlers without storing their UA', async () => {
		await post(event({ path: '/private/%2eenv.bak?secret=1' }), { 'User-Agent': 'Googlebot/2.1' });
		expect((await rows())[0]).toMatchObject({ path: '/.env', device_type: 'bot', bot_name: 'googlebot', user_agent: null, device_source: 'crawler_claim' });
	});
	it.each([
		['Mozilla/5.0 (Linux; Android 12; Tablet) AppleWebKit/537.36 Chrome/120 Safari/537.36', {}, 'tablet', 'Android'],
		['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605 Safari/605', { tablet_hint: true }, 'tablet', 'iOS'],
		['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', {}, 'desktop', 'Windows'],
	])('classifies device without defaulting everything to desktop', async (ua, hint, type, os) => {
		await post(event(hint), { 'User-Agent': ua });
		expect((await rows())[0]).toMatchObject({ device_type: type, device_os: os });
	});
	it('discards legacy visit identifiers and can disable browser tracking', async () => {
		await post(event({ visit_id: crypto.randomUUID(), session_id: 'persistent-id' }), {}, { ...config, TRACK_VISITORS: 'false' });
		expect((await rows())[0]).toMatchObject({ session_id: null, visitor_id: null });
	});
	it('uses only Cloudflare network IPs, with an explicit logging switch', async () => {
		await post(event({ ip: '192.0.2.1' }), { 'X-Forwarded-For': '192.0.2.2' });
		await post(event(), { 'CF-Connecting-IP': '2001:db8::1' });
		await post(event(), { 'CF-Connecting-IP': '192.0.2.3' }, { ...config, LOG_IPS: 'false' });
		expect((await rows()).map(row => row.ip)).toEqual([null, '2001:db8::1', null]);
	});
	it('keeps first-seen stable and refreshes last-seen for known browsers', async () => {
		const body = event();
		await post(body);
		await env.DB.prepare('UPDATE visitors SET first_seen = 1, last_seen = 2 WHERE visitor_id = ?').bind(body.visitor_id).run();
		await post({ ...body, event_id: crypto.randomUUID() });
		const visitor = await env.DB.prepare('SELECT * FROM visitors WHERE visitor_id = ?').bind(body.visitor_id).first();
		expect(visitor.first_seen).toBe(1);
		expect(visitor.last_seen).toBeGreaterThan(2);
	});
	it('scrubs older IPs without deleting recent analytics or legacy records', async () => {
		const tenDaysAgo = Date.now() - 10 * 86400000;
		await env.DB.prepare('INSERT INTO analytics (ts, type, tracker_version, ip) VALUES (?, ?, ?, ?)').bind(tenDaysAgo, 'page_view', 2, '192.0.2.1').run();
		await env.DB.prepare('INSERT INTO analytics (ts, type, ip) VALUES (?, ?, ?)').bind(tenDaysAgo, 'page_view', '192.0.2.2').run();
		await worker.scheduled({}, config);
		expect((await rows()).map(row => row.ip)).toEqual([null, '192.0.2.2']);
	});
	it('retention removes expired v2 rows while preserving recent and legacy records', async () => {
		const past = Date.now() - 100 * 86400000;
		await env.DB.prepare('INSERT INTO analytics (ts, type, tracker_version) VALUES (?, ?, ?)').bind(past, 'page_view', 2).run();
		await env.DB.prepare('INSERT INTO analytics (ts, type) VALUES (?, ?)').bind(past, 'page_view').run();
		await post(event());
		await worker.scheduled({}, config);
		const remaining = await rows();
		expect(remaining).toHaveLength(2);
		expect(remaining.some(row => row.tracker_version === null)).toBe(true);
		expect(remaining.some(row => row.event_id !== null)).toBe(true);
	});
});
