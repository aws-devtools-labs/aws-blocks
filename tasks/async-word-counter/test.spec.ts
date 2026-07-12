import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const APPEAR = 8_000;
const DONE = 20_000; // background job + poll interval

const RUN = process.env.RUN_ID || String(Date.now());
let seq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++seq}-${Date.now()}`;

function watchErrors(page: Page, sink: string[] = []): string[] {
	page.on('pageerror', (err) => sink.push(String(err)));
	return sink;
}

async function rpc(
	request: APIRequestContext,
	method: string,
	params: unknown[] | undefined,
	opts: { omitParams?: boolean } = {},
): Promise<{ status: number; body: any }> {
	const data: Record<string, unknown> = { jsonrpc: '2.0', method, id: ++seq };
	if (!opts.omitParams) data.params = params ?? [];
	const res = await request.post(`${BASE}/aws-blocks/api`, {
		headers: { 'Content-Type': 'application/json' },
		data,
	});
	return { status: res.status(), body: await res.json().catch(() => null) };
}

async function enqueue(request: APIRequestContext, text: string): Promise<string> {
	const { body } = await rpc(request, 'api.enqueue', [text]);
	expect(body?.error, `JSON-RPC error from enqueue: ${JSON.stringify(body?.error)}`).toBeFalsy();
	const id = body?.result?.id;
	expect(typeof id, `enqueue must return { id: string }, got ${JSON.stringify(body?.result)}`).toBe('string');
	expect(String(id).length).toBeGreaterThan(0);
	return id as string;
}

// Poll api.getJob until the job reaches "done"; returns its numeric count.
async function countOf(request: APIRequestContext, id: string): Promise<number> {
	let job: any = null;
	await expect
		.poll(async () => {
			job = (await rpc(request, 'api.getJob', [id])).body?.result ?? null;
			return job?.status;
		}, { timeout: DONE })
		.toBe('done');
	expect(typeof job.count, `count must be a number, got ${JSON.stringify(job.count)}`).toBe('number');
	return job.count as number;
}

// The DOM row for a submission, located by its unique phrase text.
const rowFor = (page: Page, phrase: string) => page.getByTestId('wc-item').filter({ hasText: phrase });

test.describe('async-word-counter', () => {
	// --- Framework surface: counting + persistence graded through the api ---

	test('api.enqueue \u2192 getJob resolves to done with the correct word count', async ({ request }) => {
		const id = await enqueue(request, `${uniq('word')} one two three four`); // 5 tokens
		expect(await countOf(request, id)).toBe(5);
	});

	test('word count collapses whitespace runs and ignores leading/trailing space', async ({ request }) => {
		// Trim then split on whitespace RUNS: exactly 3 tokens.
		const id = await enqueue(request, `   ${uniq('sp')}    alpha\tbeta   `);
		expect(await countOf(request, id)).toBe(3);
	});

	test('punctuation is part of a word, not a separator', async ({ request }) => {
		// Only whitespace separates: 3 tokens (a `\W+` split would over-count).
		const id = await enqueue(request, `${uniq('punct')} hello,world foo.bar-baz!`);
		expect(await countOf(request, id)).toBe(3);
	});

	test('unicode and emoji tokens each count as one word', async ({ request }) => {
		// Five non-whitespace runs incl. non-ASCII + emoji (a `\w+` impl undercounts).
		const id = await enqueue(request, `${uniq('uni')} café 日本語 🙂 naïve`);
		expect(await countOf(request, id)).toBe(5);
	});

	test('a single token counts as exactly one word', async ({ request }) => {
		const id = await enqueue(request, uniq('solo'));
		expect(await countOf(request, id)).toBe(1);
	});

	test('getJob echoes the submitted text and a well-formed shape', async ({ request }) => {
		const text = `${uniq('shape')} lorem ipsum`;
		const id = await enqueue(request, text);
		expect(await countOf(request, id)).toBe(3);
		const job = (await rpc(request, 'api.getJob', [id])).body?.result;
		expect(job?.id).toBe(id);
		expect(job?.text).toBe(text);
		expect(job?.status).toBe('done');
	});

	test('empty / whitespace-only input is rejected and enqueues no job', async ({ request }) => {
		for (const bad of ['', '   \t  ']) {
			const { status, body } = await rpc(request, 'api.enqueue', [bad]);
			expect(status, `unexpected HTTP ${status}`).toBeLessThan(500);
			expect(body?.error, `blank input must yield a JSON-RPC error envelope (input=${JSON.stringify(bad)})`).toBeTruthy();
			expect(body?.result ?? null).toBeNull();
		}
	});

	test('an unknown job id returns a JSON-RPC error envelope', async ({ request }) => {
		const { status, body } = await rpc(request, 'api.getJob', [`missing-${uniq('x')}`]);
		expect(status, `unexpected HTTP ${status}`).toBeLessThan(500);
		expect(body?.error, 'an unknown id must yield a JSON-RPC error envelope').toBeTruthy();
		expect(body?.result ?? null).toBeNull();
	});

	test('the same text twice yields two independent jobs keyed by id', async ({ request }) => {
		const text = `${uniq('dup')} alpha beta gamma`; // 4 tokens
		const idA = await enqueue(request, text);
		const idB = await enqueue(request, text);
		expect(idA, 'the two submissions must get distinct job ids').not.toBe(idB);
		expect(await countOf(request, idA)).toBe(4);
		expect(await countOf(request, idB)).toBe(4);
	});

	test('listJobs restores every enqueued job from the store', async ({ request }) => {
		const text = `${uniq('listed')} a b`; // 3 tokens
		const id = await enqueue(request, text);
		await countOf(request, id);

		// A fresh caller (new request context has no client memory) must still
		// see the persisted job via listJobs — proof it lives in the store.
		const { body } = await rpc(request, 'api.listJobs', []);
		expect(body?.error, `JSON-RPC error: ${JSON.stringify(body?.error)}`).toBeFalsy();
		expect(Array.isArray(body?.result), 'listJobs must return an array').toBe(true);
		const mine = body.result.find((j: any) => j?.id === id);
		expect(mine, 'listJobs must include the enqueued job').toBeTruthy();
		expect(mine.text).toBe(text);
	});

	// --- Page smoke: the thin client enqueues, polls, and persists ---

	test('shows the input, submit button, and list; submit gates on non-empty text', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const input = page.getByTestId('wc-input');
		const submit = page.getByTestId('wc-submit');
		await expect(input).toBeVisible();
		await expect(page.getByTestId('wc-list')).toBeVisible();

		await input.fill('');
		await expect(submit).toBeDisabled();
		await input.fill('   \t  ');
		await expect(submit).toBeDisabled();
		await input.fill('hello world');
		await expect(submit).toBeEnabled();

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('submitting through the page resolves to done and persists across reload', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const phrase = `${uniq('ui')} one two three four five`; // 6 tokens
		await page.getByTestId('wc-input').fill(phrase);
		await page.getByTestId('wc-submit').click();

		const row = rowFor(page, phrase);
		await expect(row).toBeVisible({ timeout: APPEAR });
		await expect(row).toHaveAttribute('data-status', 'done', { timeout: DONE });
		await expect(row.getByTestId('wc-result')).toHaveText(/^\s*6\s*$/, { timeout: DONE });

		// Restored from api.listJobs on reload (not just client memory).
		await page.reload();
		await expect(rowFor(page, phrase)).toHaveAttribute('data-status', 'done', { timeout: DONE });
		await expect(rowFor(page, phrase).getByTestId('wc-result')).toHaveText(/^\s*6\s*$/, { timeout: DONE });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
