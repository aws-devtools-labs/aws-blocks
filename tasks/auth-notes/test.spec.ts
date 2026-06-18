import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const T = 8_000;
const PASSWORD = 'correct-horse-battery-staple';

// Run-stable unique identity: seeded once per worker (so a retry reuses the
// same RUN seed) yet unique per call, so tests never collide with leftover
// server state and never have to assert global counts.
const RUN = process.env.RUN_ID || String(Date.now());
let seq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++seq}-${Date.now()}`;

// Per-test no-error gate: collect ONLY uncaught page errors. Console warnings
// and 4xx/5xx responses are intentionally NOT failures — the local dev server
// returns HTTP 200 for JSON-RPC errors and 4xx pre-auth, which are expected.
function watchErrors(page: Page, sink: string[] = []): string[] {
	page.on('pageerror', (err) => sink.push(String(err)));
	return sink;
}

async function signUp(page: Page, username: string): Promise<void> {
	await expect(page.getByTestId('auth-username')).toBeVisible({ timeout: T });
	await page.getByTestId('auth-username').fill(username);
	await page.getByTestId('auth-password').fill(PASSWORD);
	await page.getByTestId('auth-submit').click();
	await expect(page.getByTestId('note-textarea')).toBeVisible({ timeout: T });
}

test.describe('auth-notes', () => {
	test('signed-out visitor sees the username/password sign-in form', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await expect(page.getByTestId('auth-username')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('auth-password')).toBeVisible();
		await expect(page.getByTestId('auth-submit')).toBeVisible();
		// Signed-in hooks must be absent before authentication.
		await expect(page.getByTestId('note-textarea')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('signing up reveals the note editor and hides the auth form', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await signUp(page, uniq('alice'));
		await expect(page.getByTestId('note-save')).toBeVisible();
		await expect(page.getByTestId('auth-username')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('saving a note shows it immediately in the display', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await signUp(page, uniq('alice'));
		const noteText = uniq('note');
		await page.getByTestId('note-textarea').fill(noteText);
		await page.getByTestId('note-save').click();
		await expect(page.getByTestId('note-display')).toHaveText(noteText, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a saved note persists across a full reload', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await signUp(page, uniq('alice'));
		const noteText = uniq('note');
		await page.getByTestId('note-textarea').fill(noteText);
		await page.getByTestId('note-save').click();
		await expect(page.getByTestId('note-display')).toHaveText(noteText, { timeout: T });

		await page.reload();
		// Still signed in and the saved note is still shown.
		await expect(page.getByTestId('note-textarea')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('note-display')).toHaveText(noteText, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('signing out returns the visitor to the sign-in form', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await signUp(page, uniq('alice'));
		await page.getByTestId('auth-signout').click();
		await expect(page.getByTestId('auth-username')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('note-textarea')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a second user sees their own empty note, never the first user (isolation)', async ({ browser }) => {
		const errors: string[] = [];

		const ctxA = await browser.newContext();
		const pageA = await ctxA.newPage();
		watchErrors(pageA, errors);
		await pageA.goto(BASE);
		const noteA = uniq('alice-secret');
		await signUp(pageA, uniq('alice'));
		await pageA.getByTestId('note-textarea').fill(noteA);
		await pageA.getByTestId('note-save').click();
		await expect(pageA.getByTestId('note-display')).toHaveText(noteA, { timeout: T });

		const ctxB = await browser.newContext();
		const pageB = await ctxB.newPage();
		watchErrors(pageB, errors);
		await pageB.goto(BASE);
		await signUp(pageB, uniq('bob'));
		// A fresh user: empty textarea + empty display, and never alice's note.
		await expect(pageB.getByTestId('note-textarea')).toHaveValue('', { timeout: T });
		await expect(pageB.getByTestId('note-display')).toHaveText('', { timeout: T });
		await expect(pageB.getByTestId('note-display')).not.toHaveText(noteA);

		await ctxA.close();
		await ctxB.close();
		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
