import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const T = 10_000;
// Agent round-trip (KB retrieval + model turn). Generous ceiling for first-load
// + KB ingestion, under Playwright's 60s per-test cap.
const REPLY = 45_000;

const RUN = process.env.RUN_ID || String(Date.now());
let seq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++seq}-${Date.now()}`;

function watchErrors(page: Page, sink: string[] = []): string[] {
	page.on('pageerror', (err) => sink.push(String(err)));
	return sink;
}

// One agent turn over the api. Non-deterministic model, so callers assert only
// on the deterministic fragments the seeded KB / fixed-output tool force in.
async function ask(
	ctx: APIRequestContext,
	message: string,
): Promise<{ status: number; body: any; reply: string; toolsUsed: string[]; citations: string[] }> {
	const res = await ctx.post(`${BASE}/aws-blocks/api`, {
		headers: { 'Content-Type': 'application/json' },
		data: { jsonrpc: '2.0', method: 'api.ask', params: [message], id: ++seq },
	});
	const body = await res.json().catch(() => null);
	const r = body?.result ?? {};
	return {
		status: res.status(),
		body,
		reply: String(r.reply ?? ''),
		toolsUsed: Array.isArray(r.toolsUsed) ? r.toolsUsed.map(String) : [],
		citations: Array.isArray(r.citations) ? r.citations.map(String) : [],
	};
}

const messages = (page: Page) => page.getByTestId('message');
const bubbleWith = (page: Page, text: string) => messages(page).filter({ hasText: text });

test.describe('kb-chat-agent', () => {
	// --- Framework surface: the agent turn runs through api.ask ---

	test('api.ask retrieves the seeded KB facts and reports the tool + a citation', async ({ request }) => {
		const a = await ask(request, 'According to the product knowledge base, what is the internal product code and the maximum hover altitude?');
		expect(a.body?.error, `JSON-RPC error from api.ask: ${JSON.stringify(a.body?.error)}`).toBeFalsy();
		// Facts live ONLY in the KB — their presence proves a real retrieval.
		expect(a.reply).toContain('QUOKKA-9F42');
		expect(a.reply).toContain('1337');
		expect(a.toolsUsed, `toolsUsed: ${JSON.stringify(a.toolsUsed)}`).toContain('searchKnowledgeBase');
		expect(a.citations.length, 'a KB answer must name a source document').toBeGreaterThan(0);
	});

	test('api.ask surfaces a SECOND distinct seeded fact (whole-passage retrieval, not a hard-coded code)', async ({ request }) => {
		const a = await ask(request, 'From the product knowledge base, what is the Nimbus-7 factory calibration code?');
		expect(a.body?.error, `error: ${JSON.stringify(a.body?.error)}`).toBeFalsy();
		// NBS-7Q6X shares the passage with QUOKKA-9F42 and is asserted nowhere else.
		expect(a.reply).toContain('NBS-7Q6X');
		expect(a.toolsUsed).toContain('searchKnowledgeBase');
	});

	test('api.ask routes an order question to the deterministic tool', async ({ request }) => {
		const a = await ask(request, 'Can you look up my order status and tracking code?');
		expect(a.body?.error, `error: ${JSON.stringify(a.body?.error)}`).toBeFalsy();
		expect(a.reply).toContain('TRK-9F42-OK');
		expect(a.toolsUsed, `toolsUsed: ${JSON.stringify(a.toolsUsed)}`).toContain('lookupOrderStatus');
	});

	test('the order tool is deterministic across two differently-phrased inputs', async ({ request }) => {
		const a1 = await ask(request, 'What is my order status right now?');
		const a2 = await ask(request, 'Please look up the shipping status for a second, different order.');
		expect(a1.reply).toContain('TRK-9F42-OK');
		expect(a2.reply).toContain('TRK-9F42-OK');
		expect(a1.toolsUsed).toContain('lookupOrderStatus');
		expect(a2.toolsUsed).toContain('lookupOrderStatus');
	});

	test('small talk retrieves nothing and does not fabricate the seeded facts', async ({ request }) => {
		const a = await ask(request, uniq('please just say a short friendly hello and nothing else'));
		expect(a.body?.error, `error: ${JSON.stringify(a.body?.error)}`).toBeFalsy();
		// Nothing to retrieve/look up → the KB/tool-only payloads must not appear.
		expect(a.reply).not.toContain('QUOKKA-9F42');
		expect(a.reply).not.toContain('NBS-7Q6X');
		expect(a.reply).not.toContain('TRK-9F42-OK');
		expect(a.toolsUsed, 'no tool should run for pure small talk').toHaveLength(0);
	});

	test('api.ask rejects a blank message with a JSON-RPC error envelope', async ({ request }) => {
		const a = await ask(request, '   ');
		expect(a.status, `unexpected HTTP ${a.status}`).toBeLessThan(500);
		expect(a.body?.error, 'a blank message must yield a JSON-RPC error envelope').toBeTruthy();
		expect(a.body?.result ?? null).toBeNull();
	});

	// --- Page smoke: the thin chat client renders the transcript ---

	test('renders the composer and an empty transcript (no seeded fact before asking)', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('chat-send')).toBeVisible();
		await expect(page.getByTestId('message-list')).toBeVisible();
		await expect(bubbleWith(page, 'QUOKKA-9F42')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('asking a KB question shows a user bubble and an assistant answer with tool-indicator + citation', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// Nothing rendered before the first answer lands.
		await expect(page.getByTestId('tool-indicator')).toHaveCount(0);
		await expect(page.getByTestId('citation')).toHaveCount(0);

		const marker = uniq('marker');
		await page.getByTestId('chat-input').fill(`Using the product knowledge base, answer this tagged request ${marker}`);
		await page.getByTestId('chat-send').click();

		// The user's question echoes as a user-role bubble.
		const mine = messages(page).filter({ hasText: marker });
		await expect(mine).toHaveCount(1, { timeout: T });
		await expect(mine).toHaveAttribute('data-role', 'user');

		// The assistant reply carries the retrieved fact in an assistant bubble.
		await expect.poll(() => bubbleWith(page, 'QUOKKA-9F42').count(), { timeout: REPLY }).toBeGreaterThan(0);
		const reply = bubbleWith(page, 'QUOKKA-9F42').first();
		await expect(reply).toHaveAttribute('data-role', 'assistant');
		await expect(reply).not.toContainText(marker);
		await expect(page.getByTestId('tool-indicator').first()).toBeVisible({ timeout: REPLY });
		await expect(page.getByTestId('citation').first()).toBeVisible({ timeout: REPLY });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('multi-turn answers accumulate in one transcript', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const orderReply = () =>
			page.locator('[data-testid=message][data-role=assistant]').filter({ hasText: 'TRK-9F42-OK' });

		const q1 = uniq('turn-one order status');
		await page.getByTestId('chat-input').fill(q1);
		await page.getByTestId('chat-send').click();
		await expect.poll(() => orderReply().count(), { timeout: REPLY }).toBe(1);

		const q2 = uniq('turn-two product knowledge base');
		await page.getByTestId('chat-input').fill(q2);
		await page.getByTestId('chat-send').click();
		await expect.poll(() => bubbleWith(page, 'QUOKKA-9F42').count(), { timeout: REPLY }).toBeGreaterThan(0);

		// Both turns' questions and distinct answers survive in the running log.
		// Scope to the user role: an assistant bubble that quotes q1 must not
		// satisfy this — only the user's own echoed bubble.
		await expect(page.locator('[data-testid=message][data-role=user]').filter({ hasText: q1 })).toHaveCount(1);
		await expect(orderReply()).toHaveCount(1);
		await expect.poll(() => messages(page).count(), { timeout: T }).toBeGreaterThan(3);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
