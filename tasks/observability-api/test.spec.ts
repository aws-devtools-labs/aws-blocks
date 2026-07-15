import { test, expect, type Page } from '@playwright/test';

// Backend template: dev server listens on :3001 (the bench harness sets
// BLOCKS_URL accordingly; the default mirrors that).
const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3001';
const T = 8_000;

// Run-stable unique suffix so echoed payloads can't collide with anything a
// retry (or another test) wrote. Mirrors the harness's RUN_ID seed.
const RUN = process.env.RUN_ID || String(Date.now());
let seq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++seq}-${Date.now()}`;

// Per-test no-error gate: ONLY uncaught page errors.
function watchErrors(page: Page, sink: string[] = []): string[] {
	page.on('pageerror', (err) => sink.push(String(err)));
	return sink;
}

async function ping(page: Page): Promise<void> {
	await expect(page.getByTestId('ping-btn')).toBeVisible({ timeout: T });
	await page.getByTestId('ping-btn').click();
	await expect
		.poll(async () => (await page.getByTestId('ping-status').textContent())?.trim() ?? '', { timeout: T })
		.toMatch(/ok/i);
}

test.describe('observability-api', () => {
	test('serves a status page showing a non-empty app name', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(`${BASE}/status`);

		// App name comes from the AppSetting block — must render and be non-empty.
		await expect(page.getByTestId('appname')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('appname')).toHaveText(/.+/, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('exposes a ping button on the status page', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(`${BASE}/status`);

		await expect(page.getByTestId('ping-btn')).toBeVisible({ timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('pinging the instrumented endpoint reports ok', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(`${BASE}/status`);

		await ping(page);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the ping is stable across repeated calls (all four blocks re-run cleanly)', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(`${BASE}/status`);

		await ping(page);
		await ping(page);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the app name is read from the setting on every load (persists across reload)', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(`${BASE}/status`);
		await expect(page.getByTestId('appname')).toHaveText(/.+/, { timeout: T });

		await page.reload();
		await expect(page.getByTestId('appname')).toHaveText(/.+/, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('api.ping returns a clean { status: "ok" } over JSON-RPC', async ({ request }) => {
		// Call the instrumented operation directly — independent of the page — and
		// require the documented JSON-RPC shape with no error envelope.
		const res = await request.post(`${BASE}/aws-blocks/api`, {
			headers: { 'Content-Type': 'application/json' },
			data: { jsonrpc: '2.0', method: 'api.ping', params: [], id: 1 },
		});
		expect(res.ok(), `HTTP ${res.status()} from api.ping`).toBe(true);
		const body = await res.json();
		expect(body.error, `JSON-RPC error: ${JSON.stringify(body.error)}`).toBeFalsy();
		expect(body.result?.status).toBe('ok');
	});

	test('the status page renders the exact configured app name', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(`${BASE}/status`);

		// The name is the configured AppSetting value, server-rendered — exact, not
		// just "non-empty" (a hard-coded placeholder would not match).
		await expect(page.getByTestId('appname')).toHaveText('Observability Service', { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the status page is served as text/html', async ({ request }) => {
		const res = await request.get(`${BASE}/status`);
		expect(res.ok(), `HTTP ${res.status()} from /status`).toBe(true);
		expect(res.headers()['content-type'] ?? '').toMatch(/text\/html/i);
	});

	test('an unmatched path returns 404', async ({ request }) => {
		// The RawRoute is mounted at /status, so an unrelated path must 404 — proof
		// the backend routes deliberately rather than serving a catch-all.
		const res = await request.get(`${BASE}/no-such-route-xyz`);
		expect(res.status()).toBe(404);
	});

	test('api.ping returns exactly { status: "ok" } with no extra fields', async ({ request }) => {
		const res = await request.post(`${BASE}/aws-blocks/api`, {
			headers: { 'Content-Type': 'application/json' },
			data: { jsonrpc: '2.0', method: 'api.ping', params: [], id: 1 },
		});
		expect(res.ok(), `HTTP ${res.status()} from api.ping`).toBe(true);
		const body = await res.json();
		expect(body.error, `JSON-RPC error: ${JSON.stringify(body.error)}`).toBeFalsy();
		// The contract is "exactly { status: 'ok' }" — extra keys (timestamp,
		// uptime, etc.) are a contract violation.
		expect(body.result).toEqual({ status: 'ok' });
	});

	test('api.ping response is JSON-RPC 2.0 compliant (echoes id, includes jsonrpc)', async ({ request }) => {
		const reqId = 87654;
		const res = await request.post(`${BASE}/aws-blocks/api`, {
			headers: { 'Content-Type': 'application/json' },
			data: { jsonrpc: '2.0', method: 'api.ping', params: [], id: reqId },
		});
		expect(res.ok(), `HTTP ${res.status()} from api.ping`).toBe(true);
		const body = await res.json();
		expect(body.jsonrpc).toBe('2.0');
		expect(body.id).toBe(reqId);
		expect(body.result?.status).toBe('ok');
	});

	test('the JSON-RPC endpoint responds with application/json', async ({ request }) => {
		const res = await request.post(`${BASE}/aws-blocks/api`, {
			headers: { 'Content-Type': 'application/json' },
			data: { jsonrpc: '2.0', method: 'api.ping', params: [], id: 1 },
		});
		expect(res.ok(), `HTTP ${res.status()} from api.ping`).toBe(true);
		expect(res.headers()['content-type'] ?? '').toMatch(/application\/json/i);
	});

	test('an unknown api method returns a JSON-RPC error envelope, not a 5xx or a success', async ({ request }) => {
		const res = await request.post(`${BASE}/aws-blocks/api`, {
			headers: { 'Content-Type': 'application/json' },
			data: { jsonrpc: '2.0', method: 'api.nope', params: [], id: 7 },
		});
		// JSON-RPC-level errors are delivered in the body (the dev server uses HTTP
		// 200 for them); a 5xx would mean the server crashed instead of replying.
		expect(res.status(), `unexpected HTTP ${res.status()}`).toBeLessThan(500);
		const body = await res.json().catch(() => ({}) as Record<string, unknown>);
		expect(body.error, 'an unknown method must yield a JSON-RPC error envelope').toBeTruthy();
		expect(body.result ?? null).toBeNull();
	});

	test('many concurrent pings each return ok (stateless, concurrency-safe)', async ({ request }) => {
		// Fire several pings in parallel: each runs its own log/metric/segment work
		// and must succeed independently — a shared mutable "current segment" or
		// other cross-call state would surface as an error or a non-ok result here.
		const calls = Array.from({ length: 8 }, (_, i) =>
			request.post(`${BASE}/aws-blocks/api`, {
				headers: { 'Content-Type': 'application/json' },
				data: { jsonrpc: '2.0', method: 'api.ping', params: [], id: 1000 + i },
			}),
		);
		const responses = await Promise.all(calls);
		for (const res of responses) {
			expect(res.ok(), `HTTP ${res.status()} under concurrency`).toBe(true);
			const body = await res.json();
			expect(body.error, `JSON-RPC error: ${JSON.stringify(body.error)}`).toBeFalsy();
			expect(body.result?.status).toBe('ok');
		}
	});

	test('api.info returns structured data — exactly { name, uptimeMs } with the configured name', async ({ request }) => {
		// "Structured data, not just status": api.info must surface the app name
		// (read from the AppSetting — exact) plus a numeric uptime, and NOTHING
		// else. Extra fields are a contract violation.
		const res = await request.post(`${BASE}/aws-blocks/api`, {
			headers: { 'Content-Type': 'application/json' },
			data: { jsonrpc: '2.0', method: 'api.info', params: [], id: 501 },
		});
		expect(res.ok(), `HTTP ${res.status()} from api.info`).toBe(true);
		const body = await res.json();
		expect(body.error, `JSON-RPC error: ${JSON.stringify(body.error)}`).toBeFalsy();
		expect(body.result, 'api.info must return a structured object').toBeTruthy();
		expect(body.result?.name).toBe('Observability Service');
		expect(typeof body.result?.uptimeMs, `uptimeMs type: ${typeof body.result?.uptimeMs}`).toBe('number');
		expect(body.result?.uptimeMs).toBeGreaterThanOrEqual(0);
		expect(Object.keys(body.result).sort()).toEqual(['name', 'uptimeMs']);
	});

	test('api.echo round-trips its argument exactly (type-preserving) and adds no extra fields', async ({ request }) => {
		const msg = uniq('echo');
		const r1 = await request.post(`${BASE}/aws-blocks/api`, {
			headers: { 'Content-Type': 'application/json' },
			data: { jsonrpc: '2.0', method: 'api.echo', params: [msg], id: 511 },
		});
		expect(r1.ok(), `HTTP ${r1.status()} from api.echo`).toBe(true);
		const b1 = await r1.json();
		expect(b1.error, `JSON-RPC error: ${JSON.stringify(b1.error)}`).toBeFalsy();
		expect(b1.result?.echo, 'echo must return the exact string argument').toBe(msg);
		expect(Object.keys(b1.result).sort()).toEqual(['echo']);

		// Type-preserving: a numeric argument must come back as a number, not "424242".
		const r2 = await request.post(`${BASE}/aws-blocks/api`, {
			headers: { 'Content-Type': 'application/json' },
			data: { jsonrpc: '2.0', method: 'api.echo', params: [424242], id: 512 },
		});
		expect(r2.ok(), `HTTP ${r2.status()} from api.echo`).toBe(true);
		const b2 = await r2.json();
		expect(b2.error, `JSON-RPC error: ${JSON.stringify(b2.error)}`).toBeFalsy();
		expect(b2.result?.echo, 'echo must preserve the numeric type').toBe(424242);
	});

	test('api.echo rejects a missing argument with a JSON-RPC error envelope (no degenerate success)', async ({ request }) => {
		// No params field at all.
		const r1 = await request.post(`${BASE}/aws-blocks/api`, {
			headers: { 'Content-Type': 'application/json' },
			data: { jsonrpc: '2.0', method: 'api.echo', id: 521 },
		});
		expect(r1.status(), `unexpected HTTP ${r1.status()}`).toBeLessThan(500);
		const b1 = await r1.json().catch(() => ({}) as Record<string, unknown>);
		expect(b1.error, 'a missing argument must yield a JSON-RPC error envelope').toBeTruthy();
		expect(b1.result ?? null).toBeNull();

		// Empty params list — same contract: validate, do not echo `undefined`.
		const r2 = await request.post(`${BASE}/aws-blocks/api`, {
			headers: { 'Content-Type': 'application/json' },
			data: { jsonrpc: '2.0', method: 'api.echo', params: [], id: 522 },
		});
		expect(r2.status(), `unexpected HTTP ${r2.status()}`).toBeLessThan(500);
		const b2 = await r2.json().catch(() => ({}) as Record<string, unknown>);
		expect(b2.error, 'an empty argument list must yield a JSON-RPC error envelope').toBeTruthy();
		expect(b2.result ?? null).toBeNull();
	});

	test('api.echo round-trips falsy-but-present arguments (0, false, null, "") — no truthiness footgun', async ({ request }) => {
		// A supplied argument that is FALSY is still present: only an absent/empty params list is
		// "missing" (covered above). An impl that detects "missing" via truthiness (`if (!arg)`)
		// wrongly rejects these — echo must key off arity (params.length), not the value's truthiness.
		const falsy: Array<number | boolean | null | string> = [0, false, null, ''];
		let id = 530;
		for (const v of falsy) {
			const res = await request.post(`${BASE}/aws-blocks/api`, {
				headers: { 'Content-Type': 'application/json' },
				data: { jsonrpc: '2.0', method: 'api.echo', params: [v], id: id++ },
			});
			expect(res.ok(), `HTTP ${res.status()} from api.echo(${JSON.stringify(v)})`).toBe(true);
			const body = await res.json();
			expect(body.error, `echo(${JSON.stringify(v)}) must not error: ${JSON.stringify(body.error)}`).toBeFalsy();
			expect(body.result, `echo(${JSON.stringify(v)}) result`).toEqual({ echo: v });
		}
	});

	test('a malformed (array/batch) request returns an InvalidRequest error envelope, not a 5xx', async ({ request }) => {
		// The framework does not support batch; an array body is an Invalid
		// Request. The contract is a clean JSON-RPC error envelope, never a crash.
		const res = await request.post(`${BASE}/aws-blocks/api`, {
			headers: { 'Content-Type': 'application/json' },
			data: [{ jsonrpc: '2.0', method: 'api.ping', params: [], id: 1 }],
		});
		expect(res.status(), `unexpected HTTP ${res.status()}`).toBeLessThan(500);
		const body = await res.json().catch(() => ({}) as Record<string, any>);
		expect(body.error, 'a malformed request must yield a JSON-RPC error envelope').toBeTruthy();
		expect(body.error?.code).toBe(-32600);
		expect(body.result ?? null).toBeNull();
	});
});
