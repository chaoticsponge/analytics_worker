import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';

describe('Analytics worker', () => {
	it('returns 404 for unknown routes', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request('http://example.com/'), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
	});

	it('handles CORS preflight on /analytics', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request('http://example.com/analytics', { method: 'OPTIONS' }), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(204);
	});

	it('blocks non-allowed origins for analytics posts', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request('http://example.com/analytics', {
				method: 'POST',
				headers: { Origin: 'http://localhost' },
				body: JSON.stringify({ type: 'page_view', path: '/', full_url: 'http://localhost/' }),
			}),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(403);
	});

	it('uses configured origins for CORS', async () => {
		const response = await worker.fetch(
			new Request('https://example.com/analytics', {
				method: 'OPTIONS',
				headers: { Origin: 'https://site.example' },
			}),
			{ ...env, ALLOWED_ORIGINS: 'https://site.example, https://other.example' },
		);
		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://site.example');
	});

	it('rejects website origins when none are configured', async () => {
		const response = await worker.fetch(
			new Request('https://example.com/analytics', {
				method: 'POST',
				headers: { Origin: 'https://site.example' },
				body: '{}',
			}),
			{ ...env, ALLOWED_ORIGINS: '' },
		);
		expect(response.status).toBe(403);
	});
});
