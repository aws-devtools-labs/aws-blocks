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

// Per-test no-error gate: collect uncaught page errors and genuine console errors. Console warnings
// and 4xx/5xx responses are intentionally NOT failures — the local dev server
// returns HTTP 200 for JSON-RPC errors and 4xx pre-auth, which are expected.
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
		await expect(page.getByTestId('note-textarea')).toHaveCount(0, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('signing up reveals the note editor and hides the auth form', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await signUp(page, uniq('alice'));
		await expect(page.getByTestId('note-save')).toBeVisible();
		await expect(page.getByTestId('auth-username')).toHaveCount(0, { timeout: T });

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
		await expect(page.getByTestId('note-textarea')).toHaveCount(0, { timeout: T });

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
		// A fresh user: empty textarea + empty display (which already proves bob
		// never sees alice's note — an empty display cannot equal noteA).
		await expect(pageB.getByTestId('note-textarea')).toHaveValue('', { timeout: T });
		await expect(pageB.getByTestId('note-display')).toHaveText('', { timeout: T });

		await ctxA.close();
		await ctxB.close();
		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('saving again overwrites the note; only the latest value persists across reload', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await signUp(page, uniq('alice'));
		const first = uniq('first');
		await page.getByTestId('note-textarea').fill(first);
		await page.getByTestId('note-save').click();
		await expect(page.getByTestId('note-display')).toHaveText(first, { timeout: T });

		const second = uniq('second');
		await page.getByTestId('note-textarea').fill(second); // fill() replaces existing content
		await page.getByTestId('note-save').click();
		await expect(page.getByTestId('note-display')).toHaveText(second, { timeout: T });

		await page.reload();
		// Exact-text match: an append-style impl would render `first` + `second`.
		await expect(page.getByTestId('note-display')).toHaveText(second, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('saving an empty textarea clears the note, and the cleared state persists', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await signUp(page, uniq('alice'));
		const note = uniq('note');
		await page.getByTestId('note-textarea').fill(note);
		await page.getByTestId('note-save').click();
		await expect(page.getByTestId('note-display')).toHaveText(note, { timeout: T });

		// An empty save is allowed and clears the note — not ignored.
		await page.getByTestId('note-textarea').fill('');
		await page.getByTestId('note-save').click();
		await expect(page.getByTestId('note-display')).toHaveText('', { timeout: T });

		await page.reload();
		await expect(page.getByTestId('note-display')).toHaveText('', { timeout: T });
		await expect(page.getByTestId('note-textarea')).toHaveValue('', { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('note text is rendered verbatim, not interpreted as HTML', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await signUp(page, uniq('alice'));
		// Contains markup; must render as literal characters, not a <b> element.
		const raw = `<b>${uniq('x')}</b> & <i>plain</i>`;
		await page.getByTestId('note-textarea').fill(raw);
		await page.getByTestId('note-save').click();
		await expect(page.getByTestId('note-display')).toHaveText(raw, { timeout: T });
		// An innerHTML impl would create a real <b>; a text impl has none.
		await expect(page.getByTestId('note-display').locator('b')).toHaveCount(0);

		await page.reload();
		await expect(page.getByTestId('note-display')).toHaveText(raw, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('after reload the textarea is pre-filled with the saved note for editing', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await signUp(page, uniq('alice'));
		const note = uniq('draft');
		await page.getByTestId('note-textarea').fill(note);
		await page.getByTestId('note-save').click();
		await expect(page.getByTestId('note-display')).toHaveText(note, { timeout: T });

		await page.reload();
		// The editor must be repopulated (not blank) so the user can keep editing.
		await expect(page.getByTestId('note-textarea')).toHaveValue(note, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a long note round-trips verbatim across reload', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await signUp(page, uniq('alice'));
		// ~1.2k characters with a unique marker, exercising larger stored values.
		const marker = uniq('long');
		const note = (marker + ' ' + 'lorem ipsum dolor sit amet '.repeat(45)).trim();
		await page.getByTestId('note-textarea').fill(note);
		await page.getByTestId('note-save').click();
		await expect(page.getByTestId('note-display')).toHaveText(note, { timeout: T });

		await page.reload();
		await expect(page.getByTestId('note-display')).toHaveText(note, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
