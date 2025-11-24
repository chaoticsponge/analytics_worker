var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, 'name', { value, configurable: true });

// src/index.js
var ALLOWED_ORIGINS = /* @__PURE__ */ new Set(['https://emmr.me']);
function getCorsHeaders(origin) {
	if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Allow-Credentials': 'true',
		'Access-Control-Max-Age': '86400',
		Vary: 'Origin',
	};
}
__name(getCorsHeaders, 'getCorsHeaders');
function toIntOrNull(val) {
	if (val === null || val === void 0 || val === '') return null;
	const n = Number(val);
	return Number.isFinite(n) ? Math.round(n) : null;
}
__name(toIntOrNull, 'toIntOrNull');
async function insertAnalyticsEvent(env, req, body) {
	const now = Date.now();
	const cf = req.cf || {};
	const headers = req.headers;
	const ip = headers.get('cf-connecting-ip') || (headers.get('x-forwarded-for') || '').split(',')[0].trim() || null;
	const country = cf.country || null;
	const city = cf.city || null;
	const colo = cf.colo || null;
	const type = body.type || 'page_view';
	const path = body.path || null;
	const full_url = body.full_url || null;
	const referrer = body.referrer || null;
	const user_agent = body.user_agent || headers.get('User-Agent') || null;
	const session_id = body.session_id || null;
	const duration_ms = toIntOrNull(body.duration_ms);
	const scroll_pct = toIntOrNull(body.scroll_pct);
	const utm = body.utm || {};
	const utm_source = body.utm_source || utm.utm_source || null;
	const utm_medium = body.utm_medium || utm.utm_medium || null;
	const utm_campaign = body.utm_campaign || utm.utm_campaign || null;
	const utm_term = body.utm_term || utm.utm_term || null;
	const utm_content = body.utm_content || utm.utm_content || null;
	const device = body.device || {};
	const device_type = body.device_type || device.device_type || device.type || null;
	const device_os = body.device_os || device.device_os || device.os || null;
	const device_browser = body.device_browser || device.device_browser || device.browser || null;
	console.log('analytics payload', JSON.stringify(body));
	const stmt = env.DB.prepare(
		`INSERT INTO analytics (
      ts,
      type,
      path,
      full_url,
      referrer,
      user_agent,
      duration_ms,
      scroll_pct,
      session_id,
      utm_source,
      utm_medium,
      utm_campaign,
      utm_term,
      utm_content,
      device_type,
      device_os,
      device_browser,
      ip,
      country,
      city,
      colo
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	);
	const result = await stmt
		.bind(
			now,
			type,
			path,
			full_url,
			referrer,
			user_agent,
			duration_ms,
			scroll_pct,
			session_id,
			utm_source,
			utm_medium,
			utm_campaign,
			utm_term,
			utm_content,
			device_type,
			device_os,
			device_browser,
			ip,
			country,
			city,
			colo,
		)
		.run();
	console.log('D1 insert result:', result);
	return result;
}
__name(insertAnalyticsEvent, 'insertAnalyticsEvent');
var index_default = {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const origin = request.headers.get('Origin') || '';
		const corsHeaders = getCorsHeaders(origin);
		if (url.pathname === '/analytics' && (!origin || !ALLOWED_ORIGINS.has(origin))) {
			return new Response('Forbidden origin', { status: 403 });
		}
		if (request.method === 'OPTIONS' && url.pathname === '/analytics') {
			return new Response(null, { status: 204, headers: corsHeaders });
		}
		if (request.method === 'POST' && url.pathname === '/analytics') {
			const postOrigin = request.headers.get('Origin') || '';
			const isLocal =
				postOrigin.startsWith('http://localhost') ||
				postOrigin.startsWith('http://127.0.0.1') ||
				postOrigin.startsWith('file://') ||
				postOrigin === '';
			if (isLocal) {
				console.log('Skipping local analytics:', postOrigin);
				return new Response(null, { status: 204, headers: corsHeaders });
			}
			let body = {};
			try {
				body = await request.json();
			} catch (e) {
				console.error('Failed to parse JSON body', e);
				body = {};
			}
			const result = await insertAnalyticsEvent(env, request, body);
			return new Response(JSON.stringify(result), {
				status: 200,
				headers: {
					...corsHeaders,
					'Content-Type': 'application/json',
				},
			});
		}
		return new Response('Not found', { status: 404 });
	},
};
export { index_default as default };
//# sourceMappingURL=index.js.map
