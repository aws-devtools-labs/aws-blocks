import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const T = 5_000;

const RUN = process.env.RUN_ID || String(Date.now());
let seq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++seq}-${Date.now()}`;

// Per-test no-error gate: uncaught page errors and genuine console errors.
function watchErrors(page: Page, sink: string[] = []): string[] {
	page.on('pageerror', (err) => sink.push(String(err)));
	page.on('console', (msg) => {
		if (msg.type() !== 'error') return;
		const text = msg.text();
		// Exclude benign browser-generated noise (not an app JS fault): failed resource loads / HTTP
		// status errors (favicon, pre-auth 4xx, JSON-RPC-over-HTTP), WebSocket lifecycle, and dev-mode
		// "Warning:" logs. A genuine console error still fails the gate, asserted empty end-of-test.
		if (/Failed to load resource|net::ERR|favicon|WebSocket|^\s*Warning:/i.test(text)) return;
		sink.push(`console.error: ${text}`);
	});
	return sink;
}

// Minimal JSON-RPC helper (the local dev server returns HTTP 200 even for
// JSON-RPC errors, so callers inspect body.error / body.result).
async function rpc(
	request: APIRequestContext,
	method: string,
	params: unknown[] = [],
): Promise<{ status: number; body: any }> {
	const res = await request.post(`${BASE}/aws-blocks/api`, {
		headers: { 'Content-Type': 'application/json' },
		data: { jsonrpc: '2.0', method, params, id: Date.now() },
	});
	return { status: res.status(), body: await res.json().catch(() => null) };
}

// Read the structured last-sent record back over JSON-RPC.
async function getLast(request: APIRequestContext): Promise<{ to?: unknown; at?: unknown } | null> {
	const { body } = await rpc(request, 'api.getLastDigest', []);
	return body?.result ?? null;
}

// Trigger the digest on demand (shares the cron job's handler logic) and wait
// for the last-sent panel to report it.
async function trigger(page: Page): Promise<void> {
	await expect(page.getByTestId('trigger-btn')).toBeVisible({ timeout: T });
	await page.getByTestId('trigger-btn').click();
	await expect
		.poll(async () => (await page.getByTestId('last-email').textContent())?.trim() ?? '', { timeout: T })
		.toMatch(/sent to/i);
}

test.describe('email-digest', () => {
	test('shows the trigger button and the last-email panel', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await expect(page.getByTestId('trigger-btn')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('last-email')).toBeVisible();

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('triggering a digest reports that it was sent', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await trigger(page);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the reported digest names a recipient address', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await trigger(page);
		await expect
			.poll(async () => (await page.getByTestId('last-email').textContent())?.trim() ?? '', { timeout: T })
			.toMatch(/sent to\s+\S+@\S+/i);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the last-sent info persists across a full reload', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await trigger(page);

		await page.reload();
		await expect
			.poll(async () => (await page.getByTestId('last-email').textContent())?.trim() ?? '', { timeout: T })
			.toMatch(/sent to/i);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('triggering twice still reports a sent digest', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await trigger(page);
		await trigger(page);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the last-sent panel reports both the recipient and a timestamp', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await trigger(page);
		// Must read like "sent to <recipient> at <time>" — a recipient address AND
		// a time, not just the bare "sent to" phrase.
		await expect
			.poll(async () => (await page.getByTestId('last-email').textContent())?.trim() ?? '', { timeout: T })
			.toMatch(/sent to\s+\S+@\S+\s+at\s+\S+/i);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the exact recipient persists across a full reload', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await trigger(page);
		const text = (await page.getByTestId('last-email').textContent()) ?? '';
		const recipient = text.match(/[^\s@]+@[^\s@]+/)?.[0] ?? '';
		expect(recipient, 'last-email must name a recipient address').not.toBe('');

		// The SAME recipient must return from the key/value store after a reload —
		// proof it was persisted, not just rendered transiently in this session.
		await page.reload();
		await expect
			.poll(async () => (await page.getByTestId('last-email').textContent())?.trim() ?? '', { timeout: T })
			.toContain(recipient);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the digest is persisted as structured metadata and exposed via api.getLastDigest', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await trigger(page);

		// The last-sent record must be real structured data in the key/value store
		// — not merely a UI string — readable over JSON-RPC as { to, at }.
		let last: any = null;
		await expect
			.poll(
				async () => {
					const res = await request.post(`${BASE}/aws-blocks/api`, {
						headers: { 'Content-Type': 'application/json' },
						data: { jsonrpc: '2.0', method: 'api.getLastDigest', params: [], id: Date.now() },
					});
					if (!res.ok()) return false;
					last = (await res.json().catch(() => null))?.result ?? null;
					return !!last && typeof last.to === 'string' && typeof last.at === 'string';
				},
				{ timeout: T },
			)
			.toBe(true);

		expect(String(last.to)).toMatch(/\S+@\S+/);
		const at = Date.parse(String(last.at));
		expect(Number.isNaN(at), `getLastDigest().at must be an ISO timestamp, got: ${last.at}`).toBe(false);
		// A fresh, real timestamp — not a hard-coded string from long ago.
		expect(Math.abs(Date.now() - at)).toBeLessThan(10 * 60_000);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('getLastDigest returns exactly { to, at } with a strict ISO-8601 timestamp', async ({ page, request }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await trigger(page);

		let last: any = null;
		await expect
			.poll(
				async () => {
					last = await getLast(request);
					return !!last && typeof last.to === 'string' && typeof last.at === 'string';
				},
				{ timeout: T },
			)
			.toBe(true);

		// Exactly the two documented fields — not the whole email message.
		expect(Object.keys(last).sort(), 'getLastDigest must return exactly { to, at }').toEqual(['at', 'to']);
		// `at` must be a canonical ISO-8601 instant: it round-trips through Date.
		// A locale string ("Mon Jun 30 …") or epoch number would not.
		expect(new Date(last.at).toISOString(), `at must be canonical ISO-8601, got: ${last.at}`).toBe(last.at);
		expect(String(last.to)).toMatch(/\S+@\S+/);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('api.triggerDigestTo routes to the exact caller-supplied recipient', async ({ request }) => {
		const to = `${uniq('route')}@example.com`;
		const { body } = await rpc(request, 'api.triggerDigestTo', [to]);
		expect(body?.error, `JSON-RPC error: ${JSON.stringify(body?.error)}`).toBeFalsy();

		// The stored last-sent record must name exactly that recipient.
		await expect.poll(async () => (await getLast(request))?.to ?? '', { timeout: T }).toBe(to);
	});

	test('triggering two digests records them in order (latest recipient wins, timestamps advance)', async ({ request }) => {
		const toA = `${uniq('first')}@example.com`;
		const toB = `${uniq('second')}@example.com`;

		const a = await rpc(request, 'api.triggerDigestTo', [toA]);
		expect(a.body?.error, `JSON-RPC error: ${JSON.stringify(a.body?.error)}`).toBeFalsy();
		await expect.poll(async () => (await getLast(request))?.to ?? '', { timeout: T }).toBe(toA);
		const atA = String((await getLast(request))?.at ?? '');

		const b = await rpc(request, 'api.triggerDigestTo', [toB]);
		expect(b.body?.error, `JSON-RPC error: ${JSON.stringify(b.body?.error)}`).toBeFalsy();
		await expect.poll(async () => (await getLast(request))?.to ?? '', { timeout: T }).toBe(toB);
		const atB = String((await getLast(request))?.at ?? '');

		// The second digest is the most recent and is not stamped before the first.
		expect(atA, 'first digest must have a stored timestamp').not.toBe('');
		expect(atB, 'second digest must have a stored timestamp').not.toBe('');
		expect(Date.parse(atB)).toBeGreaterThanOrEqual(Date.parse(atA));
	});

	test('a malformed recipient is rejected and leaves the last-sent record unchanged', async ({ request }) => {
		// Establish a known-good last record first.
		const good = `${uniq('keep')}@example.com`;
		const ok = await rpc(request, 'api.triggerDigestTo', [good]);
		expect(ok.body?.error, `JSON-RPC error: ${JSON.stringify(ok.body?.error)}`).toBeFalsy();
		await expect.poll(async () => (await getLast(request))?.to ?? '', { timeout: T }).toBe(good);
		const before = await getLast(request);

		// A malformed recipient must be rejected with a JSON-RPC error envelope and
		// must NOT send or overwrite the stored record.
		const bad = await rpc(request, 'api.triggerDigestTo', ['not-an-email']);
		expect(bad.status, `unexpected HTTP ${bad.status}`).toBeLessThan(500);
		expect(bad.body?.error, 'a malformed recipient must yield a JSON-RPC error envelope').toBeTruthy();
		expect(bad.body?.result ?? null).toBeNull();

		const after = await getLast(request);
		expect(after?.to, 'last-sent recipient must be unchanged after a rejected send').toBe(before?.to);
		expect(after?.at, 'last-sent timestamp must be unchanged after a rejected send').toBe(before?.at);
	});
});
