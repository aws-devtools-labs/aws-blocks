import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const T = 5_000;

// Per-test no-error gate: ONLY uncaught page errors.
function watchErrors(page: Page, sink: string[] = []): string[] {
	page.on('pageerror', (err) => sink.push(String(err)));
	return sink;
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
});
