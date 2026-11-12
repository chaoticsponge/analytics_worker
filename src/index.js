import crawlerTokens from '../crawler_tokens.json';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY = 4096;
const list = value => new Set((value || '').split(',').map(item => item.trim()).filter(Boolean));

function deviceInfo(request, body) {
	// Read UA transiently for coarse categories; never store or log the string.
	const ua = request.headers.get('User-Agent') || '';
	const bot = crawlerTokens.find(token => ua.toLowerCase().includes(token)) || null;
	const ipad = /ipad/i.test(ua) || (/macintosh/i.test(ua) && body.tablet_hint === true);
	let type = 'unknown', source = 'unknown';
	if (bot) { type = 'bot'; source = 'crawler_claim'; }
	else if (ipad || /tablet|android(?!.*mobile)/i.test(ua)) { type = 'tablet'; source = 'ua_heuristic'; }
	else if (request.headers.get('Sec-CH-UA-Mobile') === '?1') { type = 'mobile'; source = 'client_hint'; }
	else if (/mobile|iphone|ipod/i.test(ua)) { type = 'mobile'; source = 'ua_heuristic'; }
	else if (/windows nt|macintosh|x11|cros/i.test(ua)) { type = 'desktop'; source = 'ua_heuristic'; }
	if (ipad && !/ipad/i.test(ua)) source = 'touch_heuristic';
	const os = /iphone|ipad|ipod/i.test(ua) || ipad ? 'iOS' : /android/i.test(ua) ? 'Android'
		: /windows nt/i.test(ua) ? 'Windows' : /macintosh/i.test(ua) ? 'macOS'
		: /cros/i.test(ua) ? 'ChromeOS' : /linux/i.test(ua) ? 'Linux' : 'unknown';
	const browser = /edg\/|edga\/|edgios\//i.test(ua) ? 'Edge' : /opr\/|opt\//i.test(ua) ? 'Opera'
		: /firefox|fxios/i.test(ua) ? 'Firefox' : /chrome|crios/i.test(ua) ? 'Chrome'
		: /safari/i.test(ua) ? 'Safari' : 'unknown';
	return { type, source, os, browser, bot };
}

function publicPath(raw, allowed) {
	if (typeof raw !== 'string' || raw.length > 2048 || !raw.startsWith('/') || raw.startsWith('//')) return null;
	const path = raw.split(/[?#]/, 1)[0];
	if (allowed.has(path)) return path;
	// Preserve security signals as fixed categories, without retaining arbitrary paths.
	let decoded = path.toLowerCase();
	for (let i = 0; i < 2; i++) {
		try { decoded = decodeURIComponent(decoded).toLowerCase(); } catch { break; }
	}
	decoded = decoded.replaceAll('\\', '/');
	if (/(^|\/)\.env(?:[./~]|$)/.test(decoded)) return '/.env';
	if (/(^|\/)\.git(?:\/|$)/.test(decoded)) return '/.git/config';
	if (/(^|\/)\.svn\//.test(decoded)) return '/.svn/entries';
	if (/(^|\/)\.aws\/credentials/.test(decoded)) return '/.aws/credentials';
	if (/(^|\/)\.ssh\//.test(decoded)) return '/.ssh/config';
	if (/(^|\/)wp-config\.php/.test(decoded)) return '/wp-config.php';
	if (/\/\.\.(\/|$)/.test(decoded) || decoded === '/etc/passwd') return '/etc/passwd';
	if (/^\/app\/config(\/|$)/.test(decoded)) return '/app/config/';
	if (/^\/config\.(json|php|ya?ml)$/.test(decoded)) return '/config.json';
	if (/^\/phpmyadmin(\/|$)/.test(decoded)) return '/phpmyadmin';
	if (decoded === '/server-status') return '/server-status';
	if (/^\/actuator\/(env|heapdump)$/.test(decoded)) return '/actuator/env';
	if (decoded.startsWith('/debug/default/')) return '/debug/default/';
	return '/[unlisted]';
}

function referrerHost(value, env, origin) {
	if (typeof value !== 'string' || value.length > 2048) return null;
	try {
		const url = new URL(value);
		if (!['http:', 'https:'].includes(url.protocol) || url.hostname === new URL(origin).hostname) return null;
		return list(env.REFERRER_HOSTS).has(url.hostname) ? url.hostname : '(other referral)';
	} catch { return null; }
}

async function readBody(request) {
	if (Number(request.headers.get('Content-Length')) > MAX_BODY) throw new Error('size');
	if (!request.body) throw new Error('json');
	const reader = request.body.getReader();
	const decoder = new TextDecoder();
	let text = '', size = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_BODY) { await reader.cancel(); throw new Error('size'); }
		text += decoder.decode(value, { stream: true });
	}
	return JSON.parse(text + decoder.decode());
}

export default {
	async scheduled(_controller, env) {
		const configured = Number(env.RETENTION_DAYS || 90);
		const days = Number.isInteger(configured) && configured >= 7 && configured <= 365 ? configured : 90;
		// Only records written by this collector are subject to its retention policy. Leave legacy records intact.
		const configuredIpDays = Number(env.IP_RETENTION_DAYS || 7);
		const ipDays = Number.isInteger(configuredIpDays) && configuredIpDays >= 1 && configuredIpDays <= 30 ? configuredIpDays : 7;
		await env.DB.batch([
			env.DB.prepare('DELETE FROM analytics WHERE tracker_version IN (1, 2) AND ts < ?').bind(Date.now() - days * 86400000),
			env.DB.prepare('UPDATE analytics SET ip = NULL WHERE tracker_version IN (1, 2) AND ip IS NOT NULL AND ts < ?').bind(Date.now() - ipDays * 86400000),
			env.DB.prepare('DELETE FROM visitors WHERE last_seen < ?').bind(Date.now() - 90 * 86400000),
		]);
	},
	async fetch(request, env) {
		const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
		const respond = (text, status) => new Response(text, { status, headers });
		if (new URL(request.url).pathname !== '/analytics') return respond('Not found', 404);
		const origin = request.headers.get('Origin');
		if (!origin || !list(env.ALLOWED_ORIGINS).has(origin)) return respond('Forbidden', 403);
		headers['Access-Control-Allow-Origin'] = origin;
		headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
		headers['Access-Control-Allow-Headers'] = 'Content-Type';
		if (request.method === 'OPTIONS') return respond(null, 204);
		if (request.method !== 'POST') return respond('Method not allowed', 405);
		if (request.headers.get('Sec-GPC') === '1' || request.headers.get('DNT') === '1') return respond(null, 204);
		const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim();
		if (!['application/json', 'text/plain'].includes(contentType)) return respond('Unsupported content type', 415);
		let body;
		try { body = await readBody(request); }
		catch (error) { return respond('Invalid request', error.message === 'size' ? 413 : 400); }
		// Accept old cached trackers during rollout; mark elapsed-time measurements explicitly.
		const legacy = body?.tracker_version === undefined && body?.type === 'page_view';
		const version = legacy ? 1 : body?.tracker_version;
		const eventId = legacy ? crypto.randomUUID() : body?.event_id;
		const duration = legacy ? body.duration_ms : body?.active_ms;
		if (!body || Array.isArray(body) || (!legacy && version !== 2) || body.type !== 'page_view'
			|| typeof eventId !== 'string' || !UUID.test(eventId)
			|| !Number.isInteger(duration) || duration < 0 || duration > 86400000
			|| !Number.isInteger(body.scroll_pct) || body.scroll_pct < 0 || body.scroll_pct > 100) return respond('Invalid event', 400);
		const path = publicPath(body.path, list(env.PUBLIC_PATHS || '/'));
		if (path === null) return respond('Invalid path', 400);
		const device = deviceInfo(request, body);
		const session = legacy && env.TRACK_VISITORS !== 'false' && device.type !== 'bot'
			&& typeof body.session_id === 'string' && /^[a-z0-9]{16,64}$/i.test(body.session_id) ? body.session_id : null;
		const visitor = !legacy && env.TRACK_VISITORS !== 'false' && device.type !== 'bot'
			&& typeof body.visitor_id === 'string' && UUID.test(body.visitor_id) ? body.visitor_id : null;
		// Cloudflare supplies this header; never trust the payload or X-Forwarded-For.
		const connectingIp = request.headers.get('CF-Connecting-IP') || '';
		const ip = env.LOG_IPS !== 'false' && connectingIp.length <= 45 && /^[0-9a-f:.]+$/i.test(connectingIp) ? connectingIp : null;
		const country = env.COLLECT_COUNTRY === 'true' && /^[A-Z]{2}$/.test(request.cf?.country || '') ? request.cf.country : null;
		const source = list(env.CAMPAIGN_SOURCES).has(body.utm_source) ? body.utm_source : null;
		const campaign = source && list(env.CAMPAIGN_NAMES).has(body.utm_campaign) ? body.utm_campaign : null;
		const viewport = ['small', 'medium', 'large'].includes(body.viewport_class) ? body.viewport_class : 'unknown';
		try {
			const now = Date.now();
			const insert = env.DB.prepare(`INSERT INTO analytics (
                ts, type, path, referrer, duration_ms, scroll_pct, session_id,
                utm_source, utm_campaign, device_type, device_os, device_browser,
                country, event_id, tracker_version, device_source, viewport_class, visitor_id, ip, bot_name
            ) VALUES (?, 'page_view', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(event_id) DO UPDATE SET
                duration_ms = MAX(analytics.duration_ms, excluded.duration_ms),
                scroll_pct = MAX(analytics.scroll_pct, excluded.scroll_pct)
            WHERE analytics.path = excluded.path AND analytics.tracker_version = 2`)
				.bind(now, path, referrerHost(body.referrer, env, origin), duration,
					body.scroll_pct, session, source, campaign, device.type, device.os, device.browser,
					country, eventId, version, device.source, viewport, visitor, ip, device.bot);
			const statements = [insert];
			if (visitor) statements.push(env.DB.prepare(`INSERT INTO visitors (visitor_id, first_seen, last_seen)
                VALUES (?, ?, ?) ON CONFLICT(visitor_id) DO UPDATE SET last_seen = MAX(visitors.last_seen, excluded.last_seen)`)
				.bind(visitor, now, now));
			await env.DB.batch(statements);
		} catch { return respond('Analytics temporarily unavailable', 503); }
		return respond(null, 204);
	},
};
