import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const T = 10_000;

const RUN = process.env.RUN_ID || String(Date.now());
let seq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++seq}-${Date.now()}`;

function watchErrors(page: Page, sink: string[] = []): string[] {
	page.on('pageerror', (err) => sink.push(String(err)));
	return sink;
}

async function rpc(
	ctx: APIRequestContext,
	method: string,
	params: unknown[] | undefined,
	opts: { omitParams?: boolean } = {},
): Promise<{ status: number; body: any }> {
	const data: Record<string, unknown> = { jsonrpc: '2.0', method, id: ++seq };
	if (!opts.omitParams) data.params = params ?? [];
	const res = await ctx.post(`${BASE}/aws-blocks/api`, {
		headers: { 'Content-Type': 'application/json' },
		data,
	});
	return { status: res.status(), body: await res.json().catch(() => null) };
}

async function listProducts(ctx: APIRequestContext): Promise<any[]> {
	const { body } = await rpc(ctx, 'api.listProducts', []);
	expect(body?.error, `JSON-RPC error from listProducts: ${JSON.stringify(body?.error)}`).toBeFalsy();
	return Array.isArray(body?.result) ? body.result : [];
}

const product = (page: Page, name: string) => page.getByTestId('product-item').filter({ hasText: name });

test.describe('sql-kb-catalog', () => {
	// --- Framework surface: products in real SQL, FAQ via knowledge base ---

	test('addProduct inserts a row that listProducts reads back with a numeric id', async ({ request }) => {
		const name = uniq('prod');
		const { body } = await rpc(request, 'api.addProduct', [name]);
		expect(body?.error, `JSON-RPC error from addProduct: ${JSON.stringify(body?.error)}`).toBeFalsy();
		expect(typeof body?.result?.id, 'addProduct must return a numeric id').toBe('number');
		expect(body?.result?.name).toBe(name);

		const rows = await listProducts(request);
		const row = rows.find((r) => r?.name === name);
		expect(row, 'the inserted product must be listed').toBeTruthy();
		expect(row.id).toBe(body.result.id);
	});

	test('multiple products all persist in the SQL table in a stable ascending order', async ({ request }) => {
		const a = uniq('alpha');
		const b = uniq('bravo');
		const ra = await rpc(request, 'api.addProduct', [a]);
		const rb = await rpc(request, 'api.addProduct', [b]);
		expect(ra.body?.error, `error: ${JSON.stringify(ra.body?.error)}`).toBeFalsy();
		expect(rb.body?.error, `error: ${JSON.stringify(rb.body?.error)}`).toBeFalsy();

		const rows = await listProducts(request);
		const ia = rows.findIndex((r) => r?.name === a);
		const ib = rows.findIndex((r) => r?.name === b);
		expect(ia, 'first product must be listed').toBeGreaterThanOrEqual(0);
		expect(ib, 'second product must be listed').toBeGreaterThanOrEqual(0);
		// Insertion order preserved: the earlier row precedes the later row.
		expect(ia).toBeLessThan(ib);
		expect(rows.find((r) => r?.name === a).id).toBeLessThan(rows.find((r) => r?.name === b).id);
	});

	test('addProduct rejects a blank / non-string name (no row inserted)', async ({ request }) => {
		const before = (await listProducts(request)).length;

		const blank = await rpc(request, 'api.addProduct', ['   ']);
		expect(blank.status, `unexpected HTTP ${blank.status}`).toBeLessThan(500);
		expect(blank.body?.error, 'a blank name must yield a JSON-RPC error envelope').toBeTruthy();
		expect(blank.body?.result ?? null).toBeNull();

		const missing = await rpc(request, 'api.addProduct', undefined, { omitParams: true });
		expect(missing.body?.error, 'a missing name must yield a JSON-RPC error envelope').toBeTruthy();

		expect((await listProducts(request)).length, 'no row may be inserted for a rejected name').toBe(before);
	});

	test('searchKb over the seeded FAQ returns a hit whose text really mentions the policy', async ({ request }) => {
		const { body } = await rpc(request, 'api.searchKb', ['return refund policy']);
		expect(body?.error, `JSON-RPC error from searchKb: ${JSON.stringify(body?.error)}`).toBeFalsy();
		const hits = Array.isArray(body?.result) ? body.result : [];
		expect(hits.length, 'the seeded return/refund FAQ must produce at least one hit').toBeGreaterThan(0);
		// Prove real retrieval, not a stub: some hit's text contains the seed words.
		const joined = hits.map((h: any) => String(h?.text ?? '')).join('\n').toLowerCase();
		expect(joined).toMatch(/return/);
		expect(joined).toMatch(/refund/);
	});

	test('searchKb matches a single policy keyword too', async ({ request }) => {
		const { body } = await rpc(request, 'api.searchKb', ['refund']);
		expect(body?.error, `JSON-RPC error from searchKb: ${JSON.stringify(body?.error)}`).toBeFalsy();
		const hits = Array.isArray(body?.result) ? body.result : [];
		expect(hits.length, 'a single-keyword query must still hit the FAQ').toBeGreaterThan(0);
	});

	test('searchKb with a blank query returns an empty array (no error)', async ({ request }) => {
		const { body } = await rpc(request, 'api.searchKb', ['']);
		expect(body?.error, `JSON-RPC error from searchKb: ${JSON.stringify(body?.error)}`).toBeFalsy();
		expect(Array.isArray(body?.result), 'searchKb must return an array').toBe(true);
		expect(body?.result.length).toBe(0);
	});

	// --- Page smoke: the thin client wires the inputs to the api ---

	test('shows the product form and the FAQ search controls', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await expect(page.getByTestId('product-name-input')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('add-product-btn')).toBeVisible();
		await expect(page.getByTestId('kb-query-input')).toBeVisible();
		await expect(page.getByTestId('kb-search-btn')).toBeVisible();

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('adding a product through the page lists it and it survives a reload', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const name = uniq('prod');
		await page.getByTestId('product-name-input').fill(name);
		await page.getByTestId('add-product-btn').click();
		await expect.poll(() => product(page, name).count(), { timeout: T }).toBe(1);

		await page.reload();
		await expect.poll(() => product(page, name).count(), { timeout: T }).toBe(1);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('searching the FAQ through the page renders a result (and none before searching)', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// No result is shown until a search runs.
		await expect(page.getByTestId('kb-result')).toHaveCount(0);
		await page.getByTestId('kb-query-input').fill('return refund policy');
		await page.getByTestId('kb-search-btn').click();
		await expect(page.getByTestId('kb-result').first()).toBeVisible({ timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
