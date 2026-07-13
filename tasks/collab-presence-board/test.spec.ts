import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const SYNC = 8_000;

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
	params: unknown[] = [],
): Promise<{ status: number; body: any }> {
	const res = await ctx.post(`${BASE}/aws-blocks/api`, {
		headers: { 'Content-Type': 'application/json' },
		data: { jsonrpc: '2.0', method, params, id: ++rpcSeq },
	});
	return { status: res.status(), body: await res.json().catch(() => null) };
}

const join = (ctx: APIRequestContext, name: string) => rpc(ctx, 'api.join', [name]);

async function roster(ctx: APIRequestContext): Promise<string[]> {
	const { body } = await rpc(ctx, 'api.listPresent', []);
	const rows = Array.isArray(body?.result) ? body.result : [];
	return rows.map((r: any) => String(r?.name ?? r));
}
// The shared board holds every name every test joins, so scope roster reads to
// this call's own unique names rather than asserting on absolute counts. The
// `count(...) === 1` assertions below are race-free only because the harness
// runs specs serially (fullyParallel:false / workers:1 in
// scripts/agent-bench/steps/3-build-and-test.sh); moving to >1 worker would
// require reworking them to tolerate concurrent joins of the same unique name.
const count = (names: string[], name: string) => names.filter((n) => n === name).length;

const presence = (page: Page, name: string) => page.getByTestId('presence-item').filter({ hasText: name });

// HARNESS CONTRACT: requires workers:1 (serial; shared-store assertions assume no concurrent runners)
test.describe('collab-presence-board', () => {
	// --- Framework surface: the shared board runs through the api ---

	test('api.join registers a visitor and api.listPresent reads them back from the store', async ({ request }) => {
		const name = uniq('user');
		const j = await join(request, name);
		expect(j.body?.error, `join error: ${JSON.stringify(j.body?.error)}`).toBeFalsy();
		expect(count(await roster(request), name)).toBe(1);
	});

	test('presence is keyed by name — a repeat join never duplicates the roster row', async ({ request }) => {
		const name = uniq('dup');
		await join(request, name);
		await join(request, name);
		await join(request, name);
		expect(count(await roster(request), name), 'name-keyed board must hold at most one row per name').toBe(1);
	});

	test('names round-trip verbatim through the store', async ({ request }) => {
		const name = `${uniq('xss')} <b>BOOM</b>`;
		await join(request, name);
		const names = await roster(request);
		// The exact string round-trips — no escaping, stripping, or mutation server-side.
		expect(names).toContain(name);
	});

	test('a unicode / emoji name round-trips byte-for-byte', async ({ request }) => {
		const name = `${uniq('uni')} 日本語 🙂`;
		await join(request, name);
		expect(await roster(request)).toContain(name);
	});

	test('a blank or whitespace-only name is rejected and does not change the roster', async ({ request }) => {
		// A real name of our own, so we can assert on OUR entry rather than the
		// shared roster's absolute length (which other workers/tests mutate).
		const mine = uniq('valid');
		await join(request, mine);
		expect(count(await roster(request), mine)).toBe(1);

		const bads = ['', '   ', '\t\n'];
		for (const bad of bads) {
			const j = await join(request, bad);
			expect(j.status, `unexpected HTTP ${j.status}`).toBeLessThan(500);
			expect(j.body?.error, `blank name must be rejected, got result ${JSON.stringify(j.body?.result)}`).toBeTruthy();
		}

		// No phantom entry was added by the rejected joins, and our own valid entry
		// is untouched — neither depends on the global roster length.
		const after = await roster(request);
		for (const bad of bads) expect(after, `rejected input ${JSON.stringify(bad)} leaked into the roster`).not.toContain(bad);
		expect(count(after, mine), 'the rejected joins must not disturb this visitor\u2019s entry').toBe(1);
	});

	test('multiple distinct visitors all persist in the shared roster', async ({ request }) => {
		const names = [uniq('m1'), uniq('m2'), uniq('m3')];
		for (const n of names) await join(request, n);
		const present = await roster(request);
		for (const n of names) expect(count(present, n), `${n} missing from roster`).toBe(1);
	});

	// --- Page smoke: thin client renders + primary control ---

	test('renders the composer; join is disabled until a real name is typed', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const input = page.getByTestId('presence-name-input');
		const joinBtn = page.getByTestId('join-btn');
		await expect(input).toBeVisible({ timeout: SYNC });
		await expect(joinBtn).toBeVisible();

		await input.fill('');
		await expect(joinBtn).toBeDisabled();
		await input.fill('   ');
		await expect(joinBtn).toBeDisabled();
		await input.fill(uniq('valid'));
		await expect(joinBtn).toBeEnabled();

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('joining from the UI adds a row; a markup name renders as text, not injected HTML', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const token = uniq('xss');
		const name = `${token} <b>BOOM</b>`;
		await page.getByTestId('presence-name-input').fill(name);
		await page.getByTestId('join-btn').click();

		const row = presence(page, token);
		await expect(row).toHaveCount(1, { timeout: SYNC });
		await expect(row).toContainText('<b>BOOM</b>', { timeout: SYNC });
		await expect(row.locator('b')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a reload restores the shared roster (page fetches api.listPresent on load)', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const name = uniq('persist');
		await page.getByTestId('presence-name-input').fill(name);
		await page.getByTestId('join-btn').click();
		await expect(presence(page, name)).toHaveCount(1, { timeout: SYNC });

		await page.reload();
		// A blank first-paint that only fills on the next realtime event would fail:
		// the stored roster must be fetched and rendered on load.
		await expect(presence(page, name)).toHaveCount(1, { timeout: SYNC });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a freshly-opened tab paints the pre-existing roster on mount (first-paint from listPresent)', async ({ page, request }) => {
		const errors = watchErrors(page);
		// Seed the shared board over the api BEFORE this tab ever opens — these
		// joins are "already present" from the new tab's point of view.
		const a = uniq('early');
		const b = uniq('early');
		await join(request, a);
		await join(request, b);

		// Opening the page now must render the already-present roster on load
		// (a mount-time api.listPresent), not sit blank waiting for a future
		// realtime event. Deterministic: the joins completed before goto.
		await page.goto(BASE);
		await expect(presence(page, a)).toHaveCount(1, { timeout: SYNC });
		await expect(presence(page, b)).toHaveCount(1, { timeout: SYNC });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	// --- Realtime fan-out: intrinsically two browser contexts (PARTIALLY-DOM) ---

	test('a join in one tab appears in another already-open tab in real time', async ({ browser }) => {
		const errors: string[] = [];
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const tabA = await ctxA.newPage();
		const tabB = await ctxB.newPage();
		watchErrors(tabA, errors);
		watchErrors(tabB, errors);

		await tabA.goto(BASE);
		await tabB.goto(BASE);

		const name = uniq('rt');
		await tabA.getByTestId('presence-name-input').fill(name);
		await tabA.getByTestId('join-btn').click();

		// Tab B had the board open before A joined; it must reflect A's presence
		// within a couple seconds — realtime broadcast, no reload.
		await expect.poll(() => presence(tabB, name).count(), { timeout: SYNC }).toBe(1);

		await ctxA.close();
		await ctxB.close();
		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
