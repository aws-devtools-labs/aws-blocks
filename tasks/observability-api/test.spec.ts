import { test, expect, type Page } from '@playwright/test';

// Backend template: dev server listens on :3001 (the bench harness sets
// BLOCKS_URL accordingly; the default mirrors that).
const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3001';
const T = 8_000;

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
});
