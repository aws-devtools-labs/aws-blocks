import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const SIGNIN = 10_000;
const T = 8_000;

const RUN = process.env.RUN_ID || String(Date.now());
let seq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++seq}-${Date.now()}`;

// Per-test no-error gate: ONLY uncaught page errors (persists across the
// sign-in redirect navigations).
function watchErrors(page: Page, sink: string[] = []): string[] {
	page.on('pageerror', (err) => sink.push(String(err)));
	return sink;
}

const note = (page: Page, text: string) => page.getByTestId('note-item').filter({ hasText: text });

// Stub IdP auto-approves and redirects back; the app completes the exchange and
// shows the signed-in user's subject id.
async function signIn(page: Page): Promise<void> {
	await expect(page.getByTestId('signin-btn')).toBeVisible({ timeout: T });
	await page.getByTestId('signin-btn').click();
	await expect(page.getByTestId('profile-sub')).toBeVisible({ timeout: SIGNIN });
	await expect
		.poll(async () => (await page.getByTestId('profile-sub').textContent())?.trim() ?? '', { timeout: SIGNIN })
		.toMatch(/.+/);
}

async function addNote(page: Page, text: string): Promise<void> {
	await expect(page.getByTestId('note-input')).toBeVisible({ timeout: T });
	await page.getByTestId('note-input').fill(text);
	await page.getByTestId('add-note-btn').click();
	await expect.poll(() => note(page, text).count(), { timeout: T }).toBe(1);
}

test.describe('oidc-dsql-notes', () => {
	test('signed-out visitor sees only the sign-in button', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await expect(page.getByTestId('signin-btn')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('note-input')).toHaveCount(0);
		await expect(page.getByTestId('profile-sub')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('OIDC sign-in via the stub IdP shows the subject id and the note editor', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await signIn(page);
		await expect(page.getByTestId('signin-btn')).toHaveCount(0);
		await expect(page.getByTestId('note-input')).toBeVisible();

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a signed-in user can add a note that appears in the list', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await signIn(page);
		await addNote(page, uniq('note'));

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('notes and session persist across a full reload', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await signIn(page);
		const text = uniq('note');
		await addNote(page, text);

		await page.reload();
		await expect(page.getByTestId('profile-sub')).toBeVisible({ timeout: SIGNIN });
		await expect.poll(() => note(page, text).count(), { timeout: T }).toBe(1);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('two notes from the same user coexist in the list', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await signIn(page);
		const first = uniq('note');
		const second = uniq('note');
		await addNote(page, first);
		await addNote(page, second);

		await expect.poll(() => note(page, first).count(), { timeout: T }).toBe(1);
		await expect.poll(() => note(page, second).count(), { timeout: T }).toBe(1);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
