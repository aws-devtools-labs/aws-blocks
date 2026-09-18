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

// Per-test no-error gate: uncaught page errors and genuine console errors. JSON-RPC error envelopes
// come back as HTTP 200, so they are intentionally not treated as failures.
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

	test('surfaces a SECOND distinct seeded fact — proves the answer is the retrieved passage, not a hard-coded product code', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// The calibration code `NBS-7Q6X` lives ONLY in the same seeded passage as
		// QUOKKA-9F42 and is asserted by NO other test. An impl that just hard-codes
		// the two well-known strings (QUOKKA-9F42 / 1337) would pass the retrieval
		// test above yet FAIL here — only a real retrieval that surfaces the whole
		// passage carries this second, independent fact into the reply.
		await ask(page, 'From the product knowledge base, what is the Nimbus-7 factory calibration code?');

		await expect.poll(() => bubbleWith(page, 'NBS-7Q6X').count(), { timeout: REPLY }).toBeGreaterThan(0);
		await expect(bubbleWith(page, 'NBS-7Q6X').first()).toHaveAttribute('data-role', 'assistant');

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a question with no knowledge-base match does NOT fabricate the seeded facts', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// Tool-free, KB-free small talk: it names none of the tools and asks for none
		// of the seeded content, so a faithful agent has nothing to retrieve or look
		// up. The unique token keeps the echoed question from colliding with any
		// other test's bubbles.
		const question = uniq('please just say a short friendly hello and nothing else');
		await ask(page, question);

		// Wait until the assistant has ACTUALLY replied (its own bubble, not the
		// echoed question) BEFORE asserting absence — otherwise the checks below
		// would pass vacuously against an always-answering impl before its
		// fabricated reply even lands.
		const assistant = page.locator('[data-testid=message][data-role=assistant]');
		await expect.poll(() => assistant.count(), { timeout: REPLY }).toBeGreaterThan(0);

		// No retrieval or tool call happened, so none of the KB/tool-only payloads may
		// appear anywhere on the page. Each fragment is distinctive enough never to
		// collide with a uniq()/timestamp token. Catches an impl that always answers
		// with the seeded fact regardless of the question.
		await expect(bubbleWith(page, 'QUOKKA-9F42')).toHaveCount(0);
		await expect(bubbleWith(page, 'NBS-7Q6X')).toHaveCount(0);
		await expect(bubbleWith(page, 'TRK-9F42-OK')).toHaveCount(0);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the order tool returns the SAME deterministic code across two different inputs', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const orderReplies = () =>
			page.locator('[data-testid=message][data-role=assistant]').filter({ hasText: 'TRK-9F42-OK' });

		// Two differently-phrased order questions, each routing to the order tool.
		// Its result is a fixed constant, so BOTH turns must produce an assistant
		// bubble carrying the exact same tracking code — a per-input or
		// non-deterministic tool would yield a different (or missing) second answer.
		await ask(page, 'What is my order status right now?');
		await expect.poll(() => orderReplies().count(), { timeout: REPLY }).toBe(1);

		await ask(page, 'Please look up the shipping status for a second, different order.');
		await expect.poll(() => orderReplies().count(), { timeout: REPLY }).toBe(2);

		// The tool ran on both turns (an indicator per tool-using reply).
		await expect.poll(() => page.getByTestId('tool-indicator').count(), { timeout: REPLY }).toBeGreaterThan(1);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the user question and the assistant answer render as distinct bubbles with distinct roles', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// A KB product question carrying a unique marker: the marker appears ONLY in
		// the user's echoed bubble, while the retrieved fact (QUOKKA-9F42) appears
		// ONLY in the assistant's bubble — so the two must be separate elements with
		// opposite roles, not one merged/mis-attributed bubble.
		const marker = uniq('marker');
		await ask(page, `Using the product knowledge base, answer this tagged request ${marker}`);

		const mine = messages(page).filter({ hasText: marker });
		await expect(mine).toHaveCount(1, { timeout: T });
		await expect(mine).toHaveAttribute('data-role', 'user');

		await expect.poll(() => bubbleWith(page, 'QUOKKA-9F42').count(), { timeout: REPLY }).toBeGreaterThan(0);
		const reply = bubbleWith(page, 'QUOKKA-9F42').first();
		await expect(reply).toHaveAttribute('data-role', 'assistant');
		// The answer is a DIFFERENT bubble from the user's echo: it must not carry the
		// user's marker.
		await expect(reply).not.toContainText(marker);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('multi-turn: both turns\u2019 answers accumulate in one transcript', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const orderReply = () =>
			page.locator('[data-testid=message][data-role=assistant]').filter({ hasText: 'TRK-9F42-OK' });

		// Turn 1 hits the order tool; turn 2 hits the knowledge base — two turns in
		// ONE page session. Because the transcript is a running log, BOTH assistant
		// answers (with their DIFFERENT deterministic payloads) must still be present
		// after the second turn. An impl that clears the list per turn, or re-renders
		// only the latest answer, loses the first and fails.
		const q1 = uniq('turn-one order status');
		await ask(page, q1);
		await expect.poll(() => orderReply().count(), { timeout: REPLY }).toBe(1);

		const q2 = uniq('turn-two product knowledge base');
		await ask(page, q2);
		await expect.poll(() => bubbleWith(page, 'QUOKKA-9F42').count(), { timeout: REPLY }).toBeGreaterThan(0);

		// The first turn's user + assistant messages survive alongside the second's.
		await expect(messages(page).filter({ hasText: q1 })).toHaveAttribute('data-role', 'user');
		await expect(messages(page).filter({ hasText: q2 })).toHaveAttribute('data-role', 'user');
		await expect(orderReply()).toHaveCount(1);
		await expect(bubbleWith(page, 'QUOKKA-9F42').first()).toHaveAttribute('data-role', 'assistant');
		// At least four bubbles: two questions + two distinct answers.
		await expect.poll(() => messages(page).count(), { timeout: T }).toBeGreaterThan(3);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
