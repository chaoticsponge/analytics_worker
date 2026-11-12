// Load with <script src="/js/analytics.js" data-endpoint="https://your-worker.workers.dev/analytics" defer></script>.
// For SPAs, remount after navigation or call window.dispatchEvent(new Event('analytics:navigate')).
(function () {
	'use strict';
	const script = document.currentScript;
	const endpoint = script?.dataset.endpoint;
	if (!endpoint || navigator.globalPrivacyControl === true || navigator.doNotTrack === '1' || window.doNotTrack === '1') return;
	try { if (new URL(endpoint, location.href).protocol !== 'https:') return; } catch { return; }
	const trackVisitors = script.dataset.trackVisitors !== 'false';
	const campaigns = script.dataset.campaigns === 'true';
	const idleLimit = 60000;
	let event, active = 0, maxScroll = 0, lastTick = performance.now(), lastInput = lastTick;
	let visible = document.visibilityState === 'visible';

	function visitorId() {
		if (!trackVisitors) return null;
		try {
			const key = 'analytics_visitor_v2', now = Date.now();
			let visitor = JSON.parse(localStorage.getItem(key) || 'null');
			if (!visitor || typeof visitor.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(visitor.id) || !Number.isFinite(visitor.expires) || visitor.expires <= now) {
				visitor = { id: crypto.randomUUID(), expires: now + 90 * 86400000 };
				localStorage.setItem(key, JSON.stringify(visitor));
			}
			return visitor.id;
		} catch { return null; }
	}

	function pageName() {
		let path = location.pathname.toLowerCase();
		for (let i = 0; i < 2; i++) { try { path = decodeURIComponent(path).toLowerCase(); } catch { break; } }
		path = path.replaceAll('\\', '/');
		const probes = [
			[/(^|\/)\.env(?:[./~]|$)/, '/.env'], [/(^|\/)\.git(?:\/|$)/, '/.git/config'],
			[/(^|\/)\.svn\//, '/.svn/entries'], [/(^|\/)\.aws\/credentials/, '/.aws/credentials'],
			[/(^|\/)\.ssh\//, '/.ssh/config'], [/(^|\/)wp-config\.php/, '/wp-config.php'],
			[/\/\.\.(\/|$)|^\/etc\/passwd$/, '/etc/passwd'], [/^\/app\/config(\/|$)/, '/app/config/'],
			[/^\/config\.(json|php|ya?ml)$/, '/config.json'], [/^\/phpmyadmin(\/|$)/, '/phpmyadmin'],
			[/^\/server-status$/, '/server-status'], [/^\/actuator\/(env|heapdump)$/, '/actuator/env'],
			[/^\/debug\/default\//, '/debug/default/'],
		];
		return probes.find(([pattern]) => pattern.test(path))?.[1] || script.dataset.page || '/[unlisted]';
	}

	function measure() {
		const now = performance.now();
		// Visible time with recent interaction; cap each tick to avoid counting suspended timers.
		if (visible) active += Math.max(0, Math.min(now - lastTick, 15000, lastInput + idleLimit - lastTick));
		lastTick = now;
		if (document.visibilityState !== 'visible') return;
		const doc = document.documentElement;
		const depth = doc.scrollHeight > 0 ? Math.min(100, (window.scrollY + window.innerHeight) / doc.scrollHeight * 100) : 0;
		maxScroll = Math.max(maxScroll, depth);
	}

	function send() {
		measure();
		const payload = JSON.stringify({ ...event, active_ms: Math.min(86400000, Math.round(active)), scroll_pct: Math.round(maxScroll) });
		// fetch omits credentials and referrer; retries use the same pageview ID.
		void fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
			body: payload, keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer' }).catch(() => {});
	}

	function startPage() {
		active = 0; maxScroll = 0; lastTick = performance.now(); lastInput = lastTick;
		const params = new URLSearchParams(location.search);
		event = {
			tracker_version: 2, type: 'page_view', event_id: crypto.randomUUID(), visitor_id: visitorId(),
			path: pageName(),
			referrer: (() => { try { return new URL(document.referrer).origin; } catch { return null; } })(),
			tablet_hint: navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1,
			viewport_class: window.innerWidth < 768 ? 'small' : window.innerWidth < 1200 ? 'medium' : 'large',
			utm_source: campaigns ? params.get('utm_source') : null,
			utm_campaign: campaigns ? params.get('utm_campaign') : null,
		};
		send();
	}

	for (const name of ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart']) {
		window.addEventListener(name, () => { measure(); lastInput = performance.now(); }, { passive: true });
	}
	document.addEventListener('visibilitychange', () => {
		// Account for the interval before the visibility transition, without counting hidden time.
		measure();
		visible = document.visibilityState === 'visible';
		if (visible) lastInput = lastTick;
		send();
	});
	window.addEventListener('pagehide', send);
	window.addEventListener('pageshow', event => { if (event.persisted) lastTick = performance.now(); });
	window.addEventListener('analytics:navigate', () => { send(); startPage(); });
	setInterval(() => { if (document.visibilityState === 'visible') send(); }, 15000);
	startPage();
})();
