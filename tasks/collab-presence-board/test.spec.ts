import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const SYNC = 8_000;

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

const presence = (page: Page, name: string) => page.getByTestId('presence-item').filter({ hasText: name });

async function join(page: Page, name: string): Promise<void> {
	await expect(page.getByTestId('presence-name-input')).toBeVisible({ timeout: SYNC });
	await page.getByTestId('presence-name-input').fill(name);
	await page.getByTestId('join-btn').click();
}

test.describe('collab-presence-board', () => {
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

	test('the join button is disabled until a non-empty name is entered', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const input = page.getByTestId('presence-name-input');
		const joinBtn = page.getByTestId('join-btn');
		await expect(input).toBeVisible();

		// Empty and whitespace-only names cannot be joined (trim before checking);
		// a real name re-enables the control so it isn't simply always-disabled.
		await input.fill('');
		await expect(joinBtn).toBeDisabled();
		await input.fill('   ');
		await expect(joinBtn).toBeDisabled();
		await input.fill(uniq('valid'));
		await expect(joinBtn).toBeEnabled();

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a visitor name with markup is rendered as text, not injected as HTML', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// Names are untrusted. A correct impl renders the name as text (escaped);
		// one that uses innerHTML would parse this into a real <b> element.
		const token = uniq('xss');
		const name = `${token} <b>BOOM</b>`;
		await join(page, name);

		// Scope by the clean unique token (a substring of the name).
		const row = presence(page, token);
		await expect(row).toHaveCount(1, { timeout: SYNC });
		// The markup is shown verbatim as text...
		await expect(row).toContainText('<b>BOOM</b>', { timeout: SYNC });
		// ...and was NOT parsed into a live element.
		await expect(row.locator('b')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the shared board persists multiple visitors across a reload', async ({ browser }) => {
		const errors: string[] = [];
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const tabA = await ctxA.newPage();
		const tabB = await ctxB.newPage();
		watchErrors(tabA, errors);
		watchErrors(tabB, errors);

		await tabA.goto(BASE);
		await tabB.goto(BASE);

		const nameA = uniq('persistA');
		const nameB = uniq('persistB');
		await join(tabA, nameA);
		await join(tabB, nameB);

		// Both rosters first reach tab A via realtime...
		await expect.poll(() => presence(tabA, nameA).count(), { timeout: SYNC }).toBe(1);
		await expect.poll(() => presence(tabA, nameB).count(), { timeout: SYNC }).toBe(1);

		// ...then a reload of tab A must restore BOTH from the persisted board —
		// not just the visitor who joined in this tab.
		await tabA.reload();
		await expect.poll(() => presence(tabA, nameA).count(), { timeout: SYNC }).toBe(1);
		await expect.poll(() => presence(tabA, nameB).count(), { timeout: SYNC }).toBe(1);

		await ctxA.close();
		await ctxB.close();
		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('joining with a name already present does not create a duplicate row', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const name = uniq('dup');
		await join(page, name);
		await expect(presence(page, name)).toHaveCount(1, { timeout: SYNC });

		// Join the SAME name again. Presence is keyed by name, so this must NOT add
		// a second row (an append-by-random-key impl would).
		await join(page, name);

		// Deterministic flush: a sentinel join issued AFTER the duplicate must
		// round-trip through the same persist/broadcast path. Once its row is
		// visible, the duplicate join above has fully settled — so the count for
		// `name` is final (not racing an in-flight second row).
		const sentinel = uniq('flush');
		await join(page, sentinel);
		await expect(presence(page, sentinel)).toHaveCount(1, { timeout: SYNC });

		await expect(presence(page, name)).toHaveCount(1, { timeout: SYNC });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a tab opened AFTER others have joined loads the existing roster on first paint', async ({ browser }) => {
		const errors: string[] = [];
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const tabA = await ctxA.newPage();
		const tabB = await ctxB.newPage();
		watchErrors(tabA, errors);
		watchErrors(tabB, errors);

		await tabA.goto(BASE);
		await tabB.goto(BASE);
		const nameA = uniq('early-a');
		const nameB = uniq('early-b');
		await join(tabA, nameA);
		await join(tabB, nameB);
		// Make sure both are committed/broadcast before the late tab opens.
		await expect.poll(() => presence(tabA, nameA).count(), { timeout: SYNC }).toBe(1);
		await expect.poll(() => presence(tabA, nameB).count(), { timeout: SYNC }).toBe(1);

		// A brand-new tab opens with no prior realtime events: it must fetch the
		// stored roster on load and show BOTH immediately — a realtime-only impl
		// (no initial fetch) would show a blank board here.
		const ctxC = await browser.newContext();
		const tabC = await ctxC.newPage();
		watchErrors(tabC, errors);
		await tabC.goto(BASE);
		await expect.poll(() => presence(tabC, nameA).count(), { timeout: SYNC }).toBe(1);
		await expect.poll(() => presence(tabC, nameB).count(), { timeout: SYNC }).toBe(1);

		await ctxA.close();
		await ctxB.close();
		await ctxC.close();
		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a unicode/emoji name renders correctly on the board', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const token = uniq('uni');
		const name = `${token} 日本語 🙂`;
		await join(page, name);

		const row = presence(page, token);
		await expect(row).toHaveCount(1, { timeout: SYNC });
		await expect(row).toContainText('日本語', { timeout: SYNC });
		await expect(row).toContainText('🙂', { timeout: SYNC });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('multiple names joined from one tab all persist across a reload', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const names = [uniq('m1'), uniq('m2'), uniq('m3')];
		for (const n of names) {
			await join(page, n);
			await expect(presence(page, n)).toHaveCount(1, { timeout: SYNC });
		}

		await page.reload();
		for (const n of names) {
			await expect(presence(page, n)).toHaveCount(1, { timeout: SYNC });
		}

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
