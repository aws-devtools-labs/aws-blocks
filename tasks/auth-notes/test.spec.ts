import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const T = 8_000;
const PASSWORD = 'correct-horse-battery-staple';

const RUN = process.env.RUN_ID || String(Date.now());
let rpcSeq = 0;
let uniqSeq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++uniqSeq}-${Date.now()}`;

// Per-test no-error gate: ONLY uncaught page errors (4xx/JSON-RPC errors are expected).
function watchErrors(page: Page, sink: string[] = []): string[] {
	page.on('pageerror', (err) => sink.push(String(err)));
	return sink;
}

// JSON-RPC call over the framework's api endpoint. `ctx` decides identity:
// page.request carries the page's sign-in cookie (authenticated user); the
// top-level `request` fixture has no cookies (unauthenticated).
async function rpc(
	ctx: APIRequestContext,
	method: string,
	params: unknown[] | undefined,
	opts: { omitParams?: boolean } = {},
): Promise<{ status: number; body: any }> {
	const data: Record<string, unknown> = { jsonrpc: '2.0', method, id: ++rpcSeq };
	if (!opts.omitParams) data.params = params ?? [];
	const res = await ctx.post(`${BASE}/aws-blocks/api`, {
		headers: { 'Content-Type': 'application/json' },
		data,
	});
	return { status: res.status(), body: await res.json().catch(() => null) };
}

// Sign up (or in) through the DOM, establishing the auth session cookie on
// this page's context — after this, page.request calls the api as this user.
async function signUp(page: Page, username: string): Promise<void> {
	await expect(page.getByTestId('auth-username')).toBeVisible({ timeout: T });
	await page.getByTestId('auth-username').fill(username);
	await page.getByTestId('auth-password').fill(PASSWORD);
	await page.getByTestId('auth-submit').click();
	await expect(page.getByTestId('note-textarea')).toBeVisible({ timeout: T });
}

// HARNESS CONTRACT: requires workers:1 (serial; shared-store assertions assume no concurrent runners)
test.describe('auth-notes', () => {
	// --- Page smoke: the thin client wires up and reflects server state ---

	test('signed-out visitor sees the sign-in form; signing in reveals the editor', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await expect(page.getByTestId('auth-username')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('auth-password')).toBeVisible();
		await expect(page.getByTestId('note-textarea')).toHaveCount(0, { timeout: T });

		await signUp(page, uniq('alice'));
		await expect(page.getByTestId('note-save')).toBeVisible();
		await expect(page.getByTestId('auth-username')).toHaveCount(0, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a note saved through the page persists (via api.getNote) across a full reload', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signUp(page, uniq('alice'));

		const noteText = uniq('note');
		await page.getByTestId('note-textarea').fill(noteText);
		await page.getByTestId('note-save').click();
		await expect(page.getByTestId('note-display')).toHaveText(noteText, { timeout: T });

		await page.reload();
		// After reload the editor is repopulated from the server (api.getNote).
		await expect(page.getByTestId('note-textarea')).toHaveValue(noteText, { timeout: T });
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

	// --- Framework surface: notes read/written through the api namespace ---

	test('a fresh user\u2019s api.getNote is the empty string', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signUp(page, uniq('fresh'));

		const { body } = await rpc(page.request, 'api.getNote', []);
		expect(body?.error, `JSON-RPC error: ${JSON.stringify(body?.error)}`).toBeFalsy();
		expect(body?.result, 'getNote must return a string').toBe('');

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('api.saveNote overwrites (does not append) and api.getNote reads it back', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signUp(page, uniq('alice'));

		const first = uniq('first');
		const s1 = await rpc(page.request, 'api.saveNote', [first]);
		expect(s1.body?.error, `JSON-RPC error: ${JSON.stringify(s1.body?.error)}`).toBeFalsy();
		await expect.poll(async () => (await rpc(page.request, 'api.getNote', [])).body?.result, { timeout: T }).toBe(first);

		const second = uniq('second');
		const s2 = await rpc(page.request, 'api.saveNote', [second]);
		expect(s2.body?.error, `JSON-RPC error: ${JSON.stringify(s2.body?.error)}`).toBeFalsy();
		// Overwrite, not append — the stored value is exactly the second note.
		expect((await rpc(page.request, 'api.getNote', [])).body?.result).toBe(second);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('saving an empty string clears the note (not a no-op)', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signUp(page, uniq('alice'));

		await rpc(page.request, 'api.saveNote', [uniq('note')]);
		const cleared = await rpc(page.request, 'api.saveNote', ['']);
		expect(cleared.body?.error, `JSON-RPC error: ${JSON.stringify(cleared.body?.error)}`).toBeFalsy();
		expect((await rpc(page.request, 'api.getNote', [])).body?.result).toBe('');

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('notes are stored verbatim AND rendered as literal text — markup is never interpreted as HTML', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signUp(page, uniq('alice'));

		const raw = `<b>${uniq('x')}</b> & <i>plain</i>`;

		// API round-trip: exact string equality — no HTML escaping (&amp;) and no stripping.
		await rpc(page.request, 'api.saveNote', [raw]);
		expect((await rpc(page.request, 'api.getNote', [])).body?.result).toBe(raw);

		// DOM smoke (XSS): save the markup THROUGH the page and confirm note-display treats it as a
		// literal string, not HTML. An unsafe `innerHTML = note` sink would parse the <b>/<i> into
		// real child elements; a correct textContent render yields ZERO such nodes and the exact text.
		await page.getByTestId('note-textarea').fill(raw);
		await page.getByTestId('note-save').click();
		await expect(page.getByTestId('note-display')).toHaveText(raw, { timeout: T });
		await expect(page.getByTestId('note-display').locator('b')).toHaveCount(0);
		await expect(page.getByTestId('note-display').locator('i')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a long note round-trips unchanged through the api', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signUp(page, uniq('alice'));

		const note = (uniq('long') + ' ' + 'lorem ipsum dolor sit amet '.repeat(45)).trim();
		await rpc(page.request, 'api.saveNote', [note]);
		expect((await rpc(page.request, 'api.getNote', [])).body?.result).toBe(note);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a missing / non-string argument is rejected and leaves the note unchanged', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signUp(page, uniq('alice'));

		const keep = uniq('keep');
		await rpc(page.request, 'api.saveNote', [keep]);

		// No params at all.
		const missing = await rpc(page.request, 'api.saveNote', undefined, { omitParams: true });
		expect(missing.status, `unexpected HTTP ${missing.status}`).toBeLessThan(500);
		expect(missing.body?.error, 'a missing argument must yield a JSON-RPC error envelope').toBeTruthy();
		expect(missing.body?.result ?? null).toBeNull();

		// Non-string argument.
		const nonString = await rpc(page.request, 'api.saveNote', [12345]);
		expect(nonString.body?.error, 'a non-string argument must yield a JSON-RPC error envelope').toBeTruthy();

		// The known-good note survived both rejections.
		expect((await rpc(page.request, 'api.getNote', [])).body?.result).toBe(keep);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('note methods require a session — an unauthenticated call is refused', async ({ page, request }) => {
		const errors = watchErrors(page);
		// Establish a real note as a signed-in user.
		await page.goto(BASE);
		await signUp(page, uniq('alice'));
		await rpc(page.request, 'api.saveNote', [uniq('secret')]);

		// The top-level `request` fixture carries NO sign-in cookie: the gated
		// method must return an error envelope, never a result or someone's note.
		const anon = await rpc(request, 'api.getNote', []);
		expect(anon.status, `unexpected HTTP ${anon.status}`).toBeLessThan(500);
		expect(anon.body?.error, 'an unauthenticated getNote must yield a JSON-RPC error envelope').toBeTruthy();
		expect(anon.body?.result ?? null).toBeNull();

		const anonSave = await rpc(request, 'api.saveNote', ['hijack']);
		expect(anonSave.body?.error, 'an unauthenticated saveNote must yield a JSON-RPC error envelope').toBeTruthy();
		expect(anonSave.body?.result ?? null).toBeNull();

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('per-user isolation: each user\u2019s api.getNote returns only their own note', async ({ browser }) => {
		const errors: string[] = [];

		const ctxA = await browser.newContext();
		const pageA = await ctxA.newPage();
		watchErrors(pageA, errors);
		await pageA.goto(BASE);
		await signUp(pageA, uniq('alice'));
		const noteA = uniq('alice-secret');
		await rpc(pageA.request, 'api.saveNote', [noteA]);

		const ctxB = await browser.newContext();
		const pageB = await ctxB.newPage();
		watchErrors(pageB, errors);
		await pageB.goto(BASE);
		await signUp(pageB, uniq('bob'));
		// Bob's note is empty and is NOT alice's.
		expect((await rpc(pageB.request, 'api.getNote', [])).body?.result).toBe('');
		const noteB = uniq('bob-secret');
		await rpc(pageB.request, 'api.saveNote', [noteB]);

		// Each user still sees only their own note.
		expect((await rpc(pageA.request, 'api.getNote', [])).body?.result).toBe(noteA);
		expect((await rpc(pageB.request, 'api.getNote', [])).body?.result).toBe(noteB);

		await ctxA.close();
		await ctxB.close();
		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
