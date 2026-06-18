import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const SYNC = 8_000;

const RUN = process.env.RUN_ID || String(Date.now());
let seq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++seq}-${Date.now()}`;

// Per-test no-error gate: ONLY uncaught page errors.
function watchErrors(page: Page, sink: string[] = []): string[] {
	page.on('pageerror', (err) => sink.push(String(err)));
	return sink;
}

const presence = (page: Page, name: string) => page.getByTestId('presence-item').filter({ hasText: name });

async function join(page: Page, name: string): Promise<void> {
	await expect(page.getByTestId('presence-name-input')).toBeVisible({ timeout: SYNC });
	await page.getByTestId('presence-name-input').fill(name);
	await page.getByTestId('join-btn').click();
}

test.describe('collab-cursor-board', () => {
	test('shows the name input and the join button', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await expect(page.getByTestId('presence-name-input')).toBeVisible();
		await expect(page.getByTestId('join-btn')).toBeVisible();

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('joining adds a presence row rendering the visitor name', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const name = uniq('user');
		await join(page, name);
		await expect(presence(page, name)).toHaveCount(1, { timeout: SYNC });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a new join appears in another already-open tab in real time', async ({ browser }) => {
		const errors: string[] = [];
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const tabA = await ctxA.newPage();
		const tabB = await ctxB.newPage();
		watchErrors(tabA, errors);
		watchErrors(tabB, errors);

		await tabA.goto(BASE);
		await tabB.goto(BASE);

		const name = uniq('user');
		await join(tabA, name);

		// Tab B had the board open before A joined; it must reflect A's presence
		// within a couple seconds — realtime, no reload.
		await expect.poll(() => presence(tabB, name).count(), { timeout: SYNC }).toBe(1);

		await ctxA.close();
		await ctxB.close();
		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the roster persists across a full reload', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const name = uniq('user');
		await join(page, name);
		await expect(presence(page, name)).toHaveCount(1, { timeout: SYNC });

		await page.reload();
		await expect(presence(page, name)).toHaveCount(1, { timeout: SYNC });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('two visitors with different names both appear on the board', async ({ browser }) => {
		const errors: string[] = [];
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const tabA = await ctxA.newPage();
		const tabB = await ctxB.newPage();
		watchErrors(tabA, errors);
		watchErrors(tabB, errors);

		await tabA.goto(BASE);
		await tabB.goto(BASE);

		const nameA = uniq('ann');
		const nameB = uniq('bob');
		await join(tabA, nameA);
		await join(tabB, nameB);

		// Each tab eventually sees both rosters via realtime sync.
		await expect.poll(() => presence(tabA, nameA).count(), { timeout: SYNC }).toBe(1);
		await expect.poll(() => presence(tabA, nameB).count(), { timeout: SYNC }).toBe(1);
		await expect.poll(() => presence(tabB, nameA).count(), { timeout: SYNC }).toBe(1);
		await expect.poll(() => presence(tabB, nameB).count(), { timeout: SYNC }).toBe(1);

		await ctxA.close();
		await ctxB.close();
		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
