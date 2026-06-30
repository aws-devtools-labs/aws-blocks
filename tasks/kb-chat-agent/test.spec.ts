import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const T = 10_000; // UI render / echo
// Agent round-trip (KB retrieval + model turn). Local dev answers in
// milliseconds; the generous ceiling absorbs first-load + KB-ingestion latency
// while staying under Playwright's 60s per-test cap.
const REPLY = 45_000;

// Run-stable unique identity: seeded once per worker (a retry reuses the same
// RUN seed) yet unique per call, so an echoed question never collides with a
// bubble left by another test or an earlier attempt.
const RUN = process.env.RUN_ID || String(Date.now());
let seq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++seq}-${Date.now()}`;

// Per-test no-error gate: ONLY uncaught page errors. JSON-RPC error envelopes
// come back as HTTP 200, so they are intentionally not treated as failures.
function watchErrors(page: Page, sink: string[] = []): string[] {
	page.on('pageerror', (err) => sink.push(String(err)));
	return sink;
}

const messages = (page: Page) => page.getByTestId('message');
// A bubble located by the text it contains (substring match), so assertions
// never depend on the model's exact phrasing — only on the deterministic
// fragments the seeded KB / fixed-output tool force into the reply.
const bubbleWith = (page: Page, text: string) => messages(page).filter({ hasText: text });

async function ask(page: Page, question: string): Promise<void> {
	await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: T });
	await page.getByTestId('chat-input').fill(question);
	await page.getByTestId('chat-send').click();
}

test.describe('kb-chat-agent', () => {
	test('renders the chat composer and an empty message list', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: T });
		await expect(page.getByTestId('chat-send')).toBeVisible();
		await expect(page.getByTestId('message-list')).toBeVisible();
		// Nothing answered yet, so the seeded fact must not be on the page —
		// guards against a hard-coded reply that would pass the retrieval test
		// vacuously.
		await expect(bubbleWith(page, 'QUOKKA-9F42')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('echoes the user question as a user-role message bubble', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// A unique, tool-free question: it must surface verbatim as the user's
		// own bubble (the assistant's reply will not contain this token).
		const question = uniq('hello there');
		await ask(page, question);

		const mine = messages(page).filter({ hasText: question });
		await expect(mine).toHaveCount(1, { timeout: T });
		await expect(mine).toHaveAttribute('data-role', 'user');

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('answers a knowledge-base question with the seeded fact (proves retrieval)', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// The answer to this lives ONLY in the seeded knowledge base. The product
		// code and altitude are not in the question, so a bubble that contains them
		// can only have come from a real retrieval round-trip.
		await ask(page, 'According to the product knowledge base, what is the internal product code and the maximum hover altitude?');

		await expect.poll(() => bubbleWith(page, 'QUOKKA-9F42').count(), { timeout: REPLY }).toBeGreaterThan(0);
		// A second seeded fragment from the same document, for good measure.
		await expect.poll(() => bubbleWith(page, '1337').count(), { timeout: REPLY }).toBeGreaterThan(0);
		// The seeded fact must land in an assistant bubble, not the echoed question.
		await expect(bubbleWith(page, 'QUOKKA-9F42').first()).toHaveAttribute('data-role', 'assistant');

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a knowledge-base answer surfaces the tool-use indicator and a citation', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// Neither the tool-use indicator nor a citation may be present before any
		// answer lands — guards against always-rendered chrome passing these
		// vacuously via the global `.first()` lookups below.
		await expect(page.getByTestId('tool-indicator')).toHaveCount(0);
		await expect(page.getByTestId('citation')).toHaveCount(0);

		await ask(page, 'What does the knowledge base say about the return and refund policy?');

		// Wait for the assistant's REPLY to land — an assistant-role bubble, not the
		// echoed question (which already contains "refund", so polling that word would
		// pass vacuously before any round-trip). Once the reply is in, it must be
		// attributed: the agent called a tool and cited a source.
		await expect.poll(() => page.locator('[data-testid=message][data-role=assistant]').count(), { timeout: REPLY }).toBeGreaterThan(0);
		await expect(page.getByTestId('tool-indicator').first()).toBeVisible({ timeout: REPLY });
		await expect(page.getByTestId('citation').first()).toBeVisible({ timeout: REPLY });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('an order question returns the deterministic tool output (proves tool use)', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// No tool indicator may be present before the tool runs — guards the
		// global `.first()` lookup below against always-rendered chrome.
		await expect(page.getByTestId('tool-indicator')).toHaveCount(0);

		// This routes to a fixed-output tool whose tracking code is computable and
		// constant, so the exact string must appear in the answer regardless of how
		// the (non-deterministic) model phrases the rest of its reply.
		await ask(page, 'Can you look up my order status and tracking code?');

		await expect.poll(() => bubbleWith(page, 'TRK-9F42-OK').count(), { timeout: REPLY }).toBeGreaterThan(0);
		await expect(bubbleWith(page, 'TRK-9F42-OK').first()).toHaveAttribute('data-role', 'assistant');
		await expect(page.getByTestId('tool-indicator').first()).toBeVisible({ timeout: REPLY });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
