import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const SIGNIN = 10_000;
const T = 8_000;

const RUN = process.env.RUN_ID || String(Date.now());
let rpcSeq = 0;
let uniqSeq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++uniqSeq}-${Date.now()}`;

function watchErrors(page: Page, sink: string[] = []): string[] {
	page.on('pageerror', (err) => sink.push(String(err)));
	return sink;
}

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

const note = (page: Page, text: string) => page.getByTestId('note-item').filter({ hasText: text });

// Server-initiated OIDC sign-in through the auth block's signin route: the
// browser follows signin → stub IdP authorize (auto-approved) → callback (sets
// the session cookie) → app. After this the page's cookie jar is authenticated,
// so page.request calls the gated api as the signed-in user.
async function signIn(page: Page): Promise<void> {
	await page.goto(`${BASE}/aws-blocks/auth/signin/stub`);
	await expect(page.getByTestId('profile-sub')).toBeVisible({ timeout: SIGNIN });
	await expect
		.poll(async () => (await page.getByTestId('profile-sub').textContent())?.trim() ?? '', { timeout: SIGNIN })
		.toMatch(/.+/);
}

async function listNotes(ctx: APIRequestContext): Promise<any[]> {
	const { body } = await rpc(ctx, 'api.listNotes', []);
	expect(body?.error, `JSON-RPC error from listNotes: ${JSON.stringify(body?.error)}`).toBeFalsy();
	return Array.isArray(body?.result) ? body.result : [];
}

// Relative order of tokens within the (shared stub user) note list.
const indicesOf = (rows: any[], tokens: string[]) =>
	tokens.map((tok) => rows.findIndex((r) => String(r?.text ?? '').includes(tok)));

// HARNESS CONTRACT: requires workers:1 (serial; shared-store assertions assume no concurrent runners)
test.describe('oidc-dsql-notes', () => {
	// --- Framework surface: notes stored/queried through the api + DSQL ---

	test('api.addNote inserts a row that api.listNotes reads back with a numeric id', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signIn(page);

		const text = uniq('note');
		const { body } = await rpc(page.request, 'api.addNote', [text]);
		expect(body?.error, `JSON-RPC error from addNote: ${JSON.stringify(body?.error)}`).toBeFalsy();
		expect(typeof body?.result?.id, 'addNote must return a numeric id').toBe('number');
		expect(body?.result?.text).toBe(text);

		const rows = await listNotes(page.request);
		expect(rows.some((r) => r?.text === text), 'the note must be listed').toBe(true);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('notes are stored verbatim via parameterized SQL (quotes/markup round-trip, no injection)', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signIn(page);

		const text = `${uniq('sqlnote')} ' OR '1'='1 -- <b>BOOM</b> "q"`;
		const { body } = await rpc(page.request, 'api.addNote', [text]);
		expect(body?.error, `JSON-RPC error: ${JSON.stringify(body?.error)}`).toBeFalsy();
		// Exact string equality: a concatenated-SQL impl would break or mangle it.
		expect(body?.result?.text).toBe(text);
		expect((await listNotes(page.request)).find((r) => r?.text === text)?.text).toBe(text);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a unicode / emoji note round-trips unchanged', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signIn(page);

		const text = `${uniq('uni')} caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude42 \u2014 na\u00efve`;
		await rpc(page.request, 'api.addNote', [text]);
		expect((await listNotes(page.request)).find((r) => r?.text === text)?.text).toBe(text);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('adding the same text twice creates two separate rows (no dedup)', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signIn(page);

		const text = uniq('dupnote');
		await rpc(page.request, 'api.addNote', [text]);
		await rpc(page.request, 'api.addNote', [text]);
		const matches = (await listNotes(page.request)).filter((r) => r?.text === text);
		expect(matches, 'both identical notes must be stored as separate rows').toHaveLength(2);
		expect(matches[0].id).not.toBe(matches[1].id);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('listNotes returns notes oldest-first with strictly increasing ids, stable across calls', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signIn(page);

		const t1 = uniq('ord');
		const t2 = uniq('ord');
		const t3 = uniq('ord');
		for (const t of [t1, t2, t3]) await rpc(page.request, 'api.addNote', [t]);

		const rows = await listNotes(page.request);
		const [i1, i2, i3] = indicesOf(rows, [t1, t2, t3]);
		expect([i1, i2, i3].every((i) => i >= 0), `missing notes: ${JSON.stringify([i1, i2, i3])}`).toBe(true);
		// Creation order preserved by an explicit ORDER BY.
		expect(i1).toBeLessThan(i2);
		expect(i2).toBeLessThan(i3);
		expect(rows[i1].id).toBeLessThan(rows[i2].id);
		expect(rows[i2].id).toBeLessThan(rows[i3].id);

		// A fresh query yields the identical relative order (not unspecified row order).
		const again = await listNotes(page.request);
		const [j1, j2, j3] = indicesOf(again, [t1, t2, t3]);
		expect(j1).toBeLessThan(j2);
		expect(j2).toBeLessThan(j3);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('api.addNote rejects blank / whitespace / non-string text (no row inserted)', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signIn(page);
		const before = (await listNotes(page.request)).length;

		for (const bad of [[''], ['   '], [42]] as unknown[][]) {
			const r = await rpc(page.request, 'api.addNote', bad);
			expect(r.status, `unexpected HTTP ${r.status}`).toBeLessThan(500);
			expect(r.body?.error, `must reject ${JSON.stringify(bad)} with an error envelope`).toBeTruthy();
			expect(r.body?.result ?? null).toBeNull();
		}
		const missing = await rpc(page.request, 'api.addNote', undefined, { omitParams: true });
		expect(missing.body?.error, 'a missing argument must be rejected').toBeTruthy();

		expect((await listNotes(page.request)).length, 'no rejected note may be inserted').toBe(before);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('note methods require a session — an unauthenticated call is refused', async ({ request }) => {
		// The top-level `request` fixture carries no sign-in cookie.
		const l = await rpc(request, 'api.listNotes', []);
		expect(l.status, `unexpected HTTP ${l.status}`).toBeLessThan(500);
		expect(l.body?.error, 'unauthenticated listNotes must yield an error envelope').toBeTruthy();
		expect(l.body?.result ?? null).toBeNull();

		const a = await rpc(request, 'api.addNote', ['hijack']);
		expect(a.body?.error, 'unauthenticated addNote must yield an error envelope').toBeTruthy();
		expect(a.body?.result ?? null).toBeNull();
	});

	// --- Page smoke: OIDC redirect flow + thin note client ---

	test('signed-out visitor sees only the sign-in button', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await expect(page.getByTestId('signin-btn')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('note-input')).toHaveCount(0);
		await expect(page.getByTestId('profile-sub')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('OIDC sign-in shows the subject id and note editor; a note added via the page persists across reload', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signIn(page);
		await expect(page.getByTestId('signin-btn')).toHaveCount(0);
		await expect(page.getByTestId('note-input')).toBeVisible();

		const text = uniq('note');
		await page.getByTestId('note-input').fill(text);
		await page.getByTestId('add-note-btn').click();
		await expect.poll(() => note(page, text).count(), { timeout: T }).toBe(1);

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

		await input.fill('');
		await expect(addBtn).toBeDisabled();
		await input.fill('   ');
		await expect(addBtn).toBeDisabled();
		await input.fill(uniq('valid'));
		await expect(addBtn).toBeEnabled();

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a note with markup renders as literal text, not an injected element', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);
		await signIn(page);

		const token = uniq('xss');
		const text = `${token} <b>BOOM</b>`;
		await page.getByTestId('note-input').fill(text);
		await page.getByTestId('add-note-btn').click();

		const row = note(page, token);
		await expect.poll(() => row.count(), { timeout: T }).toBe(1);
		await expect(row).toContainText('<b>BOOM</b>');
		await expect(row.locator('b')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
