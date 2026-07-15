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

// Server-initiated OIDC sign-in: navigating to the auth block's signin route
// runs the whole flow through server-side 302s — signin → stub IdP authorize
// (auto-approved by the provider's `onAuthorize`) → callback sets the session
// cookie → postSignInPath ('/'). The browser follows the redirect chain and
// lands back on the app, where the on-load session hydration shows the signed-in
// subject id. This is the same path the block's own integration tests exercise;
// it deliberately avoids the client-side PKCE redirect round-trip.
async function signIn(page: Page): Promise<void> {
	await page.goto(`${BASE}/aws-blocks/auth/signin/stub`);
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

// DOM-order index of each token within the full note list. Tokens are unique
// per run, so each matches exactly one row, and the RELATIVE order of a test's
// own tokens is stable even when other notes (the shared stub user) interleave.
async function indicesOf(page: Page, tokens: string[]): Promise<number[]> {
	const texts = await page.getByTestId('note-item').allInnerTexts();
	return tokens.map((tok) => texts.findIndex((t) => t.includes(tok)));
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

	test('the add-note button is disabled until non-empty text is entered', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signIn(page);

		const input = page.getByTestId('note-input');
		const addBtn = page.getByTestId('add-note-btn');
		await expect(input).toBeVisible();

		// Empty / whitespace-only notes are rejected (trim before checking); a real
		// note re-enables the control so it isn't simply always-disabled.
		await input.fill('');
		await expect(addBtn).toBeDisabled();
		await input.fill('   ');
		await expect(addBtn).toBeDisabled();
		await input.fill(uniq('valid'));
		await expect(addBtn).toBeEnabled();

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a note with SQL/HTML metacharacters is stored and shown verbatim', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signIn(page);

		// Single quotes must round-trip through the DSQL table (parameterized
		// query, not concatenated SQL); markup must render as text, not inject.
		const token = uniq('sqlnote');
		const text = `${token} ' OR '1'='1 -- <b>BOOM</b> "q"`;
		await page.getByTestId('note-input').fill(text);
		await page.getByTestId('add-note-btn').click();

		// Scope by the clean unique token (a substring) so it matches whether or
		// not a buggy impl strips the markup.
		const row = note(page, token);
		await expect.poll(() => row.count(), { timeout: T }).toBe(1);
		await expect(row).toContainText(`' OR '1'='1`);
		await expect(row).toContainText('<b>BOOM</b>');
		await expect(row.locator('b')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('multiple notes persist across reload and the editor still works afterward', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signIn(page);

		const a = uniq('note');
		const b = uniq('note');
		const c = uniq('note');
		await addNote(page, a);
		await addNote(page, b);
		await addNote(page, c);

		// All three survive a full reload (re-read from the DSQL table, scoped to
		// this signed-in user).
		await page.reload();
		await expect(page.getByTestId('profile-sub')).toBeVisible({ timeout: SIGNIN });
		await expect.poll(() => note(page, a).count(), { timeout: T }).toBe(1);
		await expect.poll(() => note(page, b).count(), { timeout: T }).toBe(1);
		await expect.poll(() => note(page, c).count(), { timeout: T }).toBe(1);

		// The editor remains functional after the reload — a 4th note still adds.
		const d = uniq('note');
		await addNote(page, d);
		await expect.poll(() => note(page, d).count(), { timeout: T }).toBe(1);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('notes are listed oldest-first and keep that order across a reload', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signIn(page);

		const t1 = uniq('ord');
		const t2 = uniq('ord');
		const t3 = uniq('ord');
		await addNote(page, t1);
		await addNote(page, t2);
		await addNote(page, t3);

		// Oldest-first: t1 before t2 before t3 (relative order, robust to other
		// interleaved notes from the shared stub user).
		const before = await indicesOf(page, [t1, t2, t3]);
		expect(before.every((i) => i >= 0), `missing notes: ${JSON.stringify(before)}`).toBe(true);
		expect(before[0]).toBeLessThan(before[1]);
		expect(before[1]).toBeLessThan(before[2]);

		// A reload re-reads the table; the order must be identical. An impl with no
		// explicit ORDER BY can return a different order here.
		await page.reload();
		await expect(page.getByTestId('profile-sub')).toBeVisible({ timeout: SIGNIN });
		await expect.poll(() => note(page, t3).count(), { timeout: T }).toBe(1);
		const after = await indicesOf(page, [t1, t2, t3]);
		expect(after.every((i) => i >= 0), `missing after reload: ${JSON.stringify(after)}`).toBe(true);
		expect(after[0]).toBeLessThan(after[1]);
		expect(after[1]).toBeLessThan(after[2]);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a note added after reload appears last in creation order', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signIn(page);

		const t1 = uniq('post');
		const t2 = uniq('post');
		await addNote(page, t1);
		await addNote(page, t2);

		await page.reload();
		await expect(page.getByTestId('profile-sub')).toBeVisible({ timeout: SIGNIN });
		await expect.poll(() => note(page, t2).count(), { timeout: T }).toBe(1);

		// A note created AFTER the reload must sort after the earlier two (newest
		// at the bottom of an oldest-first list) — proving order is driven by a
		// stored timestamp/id, not insertion-into-a-client-array order.
		const t3 = uniq('post');
		await addNote(page, t3);

		const idx = await indicesOf(page, [t1, t2, t3]);
		expect(idx.every((i) => i >= 0), `missing notes: ${JSON.stringify(idx)}`).toBe(true);
		expect(idx[0]).toBeLessThan(idx[1]);
		expect(idx[1]).toBeLessThan(idx[2]);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('adding the same text twice creates two separate note rows', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signIn(page);

		// Notes are not deduplicated.
		const text = uniq('dupnote');
		for (let i = 0; i < 2; i++) {
			await page.getByTestId('note-input').fill(text);
			await page.getByTestId('add-note-btn').click();
		}
		// Poll to 2 (never satisfied at 1, so a dedupe-by-text impl that keeps a
		// single row fails here).
		await expect.poll(() => note(page, text).count(), { timeout: T }).toBe(2);

		// Both rows survive a reload.
		await page.reload();
		await expect(page.getByTestId('profile-sub')).toBeVisible({ timeout: SIGNIN });
		await expect.poll(() => note(page, text).count(), { timeout: T }).toBe(2);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a unicode / emoji note is stored and shown verbatim', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signIn(page);

		const token = uniq('uni');
		const text = `${token} café 日本語 🙂 — naïve`;
		await page.getByTestId('note-input').fill(text);
		await page.getByTestId('add-note-btn').click();

		const row = note(page, token);
		await expect.poll(() => row.count(), { timeout: T }).toBe(1);
		await expect(row).toContainText('日本語', { timeout: T });
		await expect(row).toContainText('🙂', { timeout: T });

		await page.reload();
		await expect(page.getByTestId('profile-sub')).toBeVisible({ timeout: SIGNIN });
		await expect(note(page, token)).toContainText('🙂', { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('unauthenticated JSON-RPC note access is refused (no session → no note data)', async ({ request }) => {
		// No session cookie. Notes are OIDC-gated and per-user, so an unauthenticated list/add must
		// NOT return note data. Method names aren't fixed by the contract (they're the agent's choice),
		// so an unknown method also yields a JSON-RPC error envelope — this probe never spuriously
		// fails; it only fails an impl that actually serves or mutates notes with no session.
		for (const method of ['api.listNotes', 'api.addNote']) {
			const res = await request.post(`${BASE}/aws-blocks/api`, {
				headers: { 'Content-Type': 'application/json' },
				data: { jsonrpc: '2.0', method, params: method === 'api.addNote' ? [`unauth-probe-${RUN}`] : [], id: 41 },
			});
			expect(res.status(), `unexpected HTTP ${res.status()} from ${method}`).toBeLessThan(500);
			const body = await res.json().catch(() => null);
			// A non-JSON response (e.g. an auth redirect to the sign-in page) is itself a refusal: it
			// carried no note data. Only a JSON body is held to the error-envelope contract.
			if (body && typeof body === 'object') {
				expect(body.error, `${method} with no session must yield a JSON-RPC error envelope`).toBeTruthy();
				expect(body.result ?? null, `${method} must not return note data unauthenticated`).toBeNull();
			}
		}
	});
});
