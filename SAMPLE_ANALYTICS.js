// analytics.js

// If you keep using workers.dev directly:
const ANALYTICS_URL = 'Your worker URL here'; // e.g., "https://your-worker.workers.dev/analytics"

// If you later bind the worker to your own domain, you can switch to:
// const ANALYTICS_URL = "/analytics";

(function () {
	// --- SESSION ID ---
	function getSessionId() {
		try {
			const key = 'analytics_session_id';
			const existing = localStorage.getItem(key);
			if (existing) return existing;
			const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
			localStorage.setItem(key, id);
			return id;
		} catch (e) {
			// localStorage blocked
			return Math.random().toString(36).slice(2) + Date.now().toString(36);
		}
	}

	// --- UTM PARSING ---
	function parseUtm(search) {
		const params = new URLSearchParams(search || '');
		return {
			utm_source: params.get('utm_source'),
			utm_medium: params.get('utm_medium'),
			utm_campaign: params.get('utm_campaign'),
			utm_term: params.get('utm_term'),
			utm_content: params.get('utm_content'),
		};
	}

	// --- DEVICE DETECTION ---
	function detectDevice(ua) {
		ua = ua || '';

		let device_type = 'desktop';
		if (/tablet|ipad/i.test(ua)) device_type = 'tablet';
		else if (/mobi/i.test(ua)) device_type = 'mobile';

		let device_os = 'other';
		if (/windows nt/i.test(ua)) device_os = 'Windows';
		else if (/mac os x/i.test(ua)) device_os = 'macOS';
		else if (/android/i.test(ua)) device_os = 'Android';
		else if (/iphone|ipad|ipod/i.test(ua)) device_os = 'iOS';
		else if (/linux/i.test(ua)) device_os = 'Linux';

		let device_browser = 'other';
		if (/edg\//i.test(ua)) device_browser = 'Edge';
		else if (/opr\//i.test(ua)) device_browser = 'Opera';
		else if (/firefox/i.test(ua)) device_browser = 'Firefox';
		else if (/chrome|crios/i.test(ua) && !/edg\//i.test(ua)) device_browser = 'Chrome';
		else if (/safari/i.test(ua) && !/chrome|crios|opr\//i.test(ua)) device_browser = 'Safari';

		return { device_type, device_os, device_browser };
	}

	// --- SCROLL / DURATION TRACKING ---
	const startTime = Date.now();
	let maxScroll = 0;

	function getScrollPct() {
		const doc = document.documentElement || document.body;
		const scrollTop = window.pageYOffset || doc.scrollTop || 0;
		const height = doc.scrollHeight || 0;
		const vh = window.innerHeight || 0;
		if (!height) return 0;
		let pct = ((scrollTop + vh) / height) * 100;
		if (pct < 0) pct = 0;
		if (pct > 100) pct = 100;
		return pct;
	}

	window.addEventListener(
		'scroll',
		() => {
			const p = getScrollPct();
			if (p > maxScroll) maxScroll = p;
		},
		{ passive: true },
	);

	let sent = false;

	function sendPageView() {
		if (sent) return;
		sent = true;

		const loc = window.location;
		const ua = navigator.userAgent || '';
		const utm = parseUtm(loc.search);
		const device = detectDevice(ua);

		const payload = {
			// required by Worker
			type: 'page_view',
			path: loc.pathname + loc.search,
			full_url: loc.href,
			referrer: document.referrer || null,
			user_agent: ua,
			session_id: getSessionId(),
			duration_ms: Date.now() - startTime,
			scroll_pct: Math.round(maxScroll),

			// top-level UTM fields
			utm_source: utm.utm_source,
			utm_medium: utm.utm_medium,
			utm_campaign: utm.utm_campaign,
			utm_term: utm.utm_term,
			utm_content: utm.utm_content,

			// top-level device fields
			device_type: device.device_type,
			device_os: device.device_os,
			device_browser: device.device_browser,

			// also send nested versions if you want (Worker supports both)
			utm,
			device,
		};

		const body = JSON.stringify(payload);

		if (navigator.sendBeacon) {
			try {
				navigator.sendBeacon(ANALYTICS_URL, body);
				return;
			} catch (e) {
				// fallback to fetch
			}
		}

		try {
			fetch(ANALYTICS_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body,
				keepalive: true,
			});
		} catch (e) {
			// ignore
		}
	}

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') sendPageView();
	});

	window.addEventListener('pagehide', sendPageView);
})();
