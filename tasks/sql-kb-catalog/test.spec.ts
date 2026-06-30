import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const T = 10_000;

const RUN = process.env.RUN_ID || String(Date.now());
let seq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++seq}-${Date.now()}`;

// Per-test no-error gate: ONLY uncaught page errors.
function watchErrors(page: Page, sink: string[] = []): string[] {
	page.on('pageerror', (err) => sink.push(String(err)));
	return sink;
}

const product = (page: Page, name: string) => page.getByTestId('product-item').filter({ hasText: name });

async function addProduct(page: Page, name: string): Promise<void> {
	await expect(page.getByTestId('product-name-input')).toBeVisible({ timeout: T });
	await page.getByTestId('product-name-input').fill(name);
	await page.getByTestId('add-product-btn').click();
	await expect.poll(() => product(page, name).count(), { timeout: T }).toBe(1);
}

async function searchFaq(page: Page, query: string): Promise<void> {
	await expect(page.getByTestId('kb-query-input')).toBeVisible({ timeout: T });
	await page.getByTestId('kb-query-input').fill(query);
	await page.getByTestId('kb-search-btn').click();
}

test.describe('sql-kb-catalog', () => {
	test('shows the product form and the FAQ search controls', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await expect(page.getByTestId('product-name-input')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('add-product-btn')).toBeVisible();
		await expect(page.getByTestId('kb-query-input')).toBeVisible();
		await expect(page.getByTestId('kb-search-btn')).toBeVisible();

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('adding a product inserts it into the catalog list', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await addProduct(page, uniq('prod'));

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a product persists across a full reload (real SQL row)', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const name = uniq('prod');
		await addProduct(page, name);

		await page.reload();
		await expect.poll(() => product(page, name).count(), { timeout: T }).toBe(1);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('two products coexist in the catalog', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const a = uniq('alpha');
		const b = uniq('bravo');
		await addProduct(page, a);
		await addProduct(page, b);

		await expect.poll(() => product(page, a).count(), { timeout: T }).toBe(1);
		await expect.poll(() => product(page, b).count(), { timeout: T }).toBe(1);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('FAQ search over the seeded knowledge base returns a result', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// The PROMPT requires a seeded FAQ doc covering the return/refund policy.
		// Guard: no result is rendered before a search runs, so an impl that
		// shows results on load (ignoring the query) fails here.
		await expect(page.getByTestId('kb-result')).toHaveCount(0);
		await searchFaq(page, 'return refund policy');
		await expect(page.getByTestId('kb-result').first()).toBeVisible({ timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('FAQ search for a single policy keyword returns a result', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await expect(page.getByTestId('kb-result')).toHaveCount(0);
		await searchFaq(page, 'refund');
		await expect(page.getByTestId('kb-result').first()).toBeVisible({ timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
