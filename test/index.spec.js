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
});
