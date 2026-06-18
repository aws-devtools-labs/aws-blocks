import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const APPEAR = 8_000;
const DONE = 20_000; // background job + frontend poll interval

const RUN = process.env.RUN_ID || String(Date.now());
let seq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++seq}-${Date.now()}`;

// Per-test no-error gate: ONLY uncaught page errors.
function watchErrors(page: Page, sink: string[] = []): string[] {
	page.on('pageerror', (err) => sink.push(String(err)));
	return sink;
}

// A phrase with a unique leading token (keeps the submission unique per run)
// plus `total - 1` filler words, for a deterministic whitespace word count of
// exactly `total`. The uniq token has no spaces, so it counts as one word.
function phraseWithWords(total: number): string {
	const filler = Array.from({ length: Math.max(0, total - 1) }, (_, i) => `w${i}`);
	return [uniq('word'), ...filler].join(' ');
}

// The row for a specific submission, located by its unique phrase text. The
// shared list persists across the run (and across a Playwright retry), so we
// never use .first() or a result-only count — either can match a STALE row from
// another submission/attempt and pass vacuously. The phrase carries a per-call
// unique token, so this scopes to exactly the row we just submitted.
const rowFor = (page: Page, phrase: string) => page.getByTestId('wc-item').filter({ hasText: phrase });

test.describe('async-word-counter', () => {
	test('shows the text input and submit button', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await expect(page.getByTestId('wc-input')).toBeVisible();
		await expect(page.getByTestId('wc-submit')).toBeVisible();

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('submitting adds a job row carrying a valid status', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const phrase = phraseWithWords(4);
		await page.getByTestId('wc-input').fill(phrase);
		await page.getByTestId('wc-submit').click();

		// The row for THIS submission (scoped by its unique phrase) renders with
		// the status hook and a valid lifecycle status. It may already have
		// flipped to "done", so accept either rather than racing the intermediate
		// "processing" state.
		const row = rowFor(page, phrase);
		await expect(row).toBeVisible({ timeout: APPEAR });
		await expect(row.getByTestId('wc-status')).toBeVisible({ timeout: APPEAR });
		await expect(row).toHaveAttribute('data-status', /^(processing|done)$/, { timeout: APPEAR });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a submitted job resolves to done with the correct word count', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const phrase = phraseWithWords(5);
		await page.getByTestId('wc-input').fill(phrase);
		await page.getByTestId('wc-submit').click();

		// THIS submission's row must reach "done" and render its word count (5).
		const row = rowFor(page, phrase);
		await expect(row).toHaveAttribute('data-status', 'done', { timeout: DONE });
		await expect(row.getByTestId('wc-status')).toContainText(/done/i, { timeout: DONE });
		await expect(row.getByTestId('wc-result')).toHaveText(/^\s*5\s*$/, { timeout: DONE });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the word count is computed accurately for a longer phrase', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const phrase = phraseWithWords(8);
		await page.getByTestId('wc-input').fill(phrase);
		await page.getByTestId('wc-submit').click();

		// Scoped to this submission's row; its result must render exactly 8.
		const row = rowFor(page, phrase);
		await expect(row).toHaveAttribute('data-status', 'done', { timeout: DONE });
		await expect(row.getByTestId('wc-result')).toHaveText(/^\s*8\s*$/, { timeout: DONE });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a finished job persists across a full reload', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const phrase = phraseWithWords(6);
		await page.getByTestId('wc-input').fill(phrase);
		await page.getByTestId('wc-submit').click();
		await expect(rowFor(page, phrase)).toHaveAttribute('data-status', 'done', { timeout: DONE });
		await expect(rowFor(page, phrase).getByTestId('wc-result')).toHaveText(/^\s*6\s*$/, { timeout: DONE });

		await page.reload();
		await expect(rowFor(page, phrase)).toHaveAttribute('data-status', 'done', { timeout: DONE });
		await expect(rowFor(page, phrase).getByTestId('wc-result')).toHaveText(/^\s*6\s*$/, { timeout: DONE });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the submit button is disabled until non-empty text is entered', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const input = page.getByTestId('wc-input');
		const submit = page.getByTestId('wc-submit');
		await expect(input).toBeVisible();

		// Empty input cannot be submitted...
		await input.fill('');
		await expect(submit).toBeDisabled();
		// ...nor can whitespace-only input (the value must be trimmed before the
		// emptiness check) — a job with no text is meaningless.
		await input.fill('   \t  ');
		await expect(submit).toBeDisabled();
		// Real text re-enables submit, so the control isn't simply always-disabled.
		await input.fill('hello world');
		await expect(submit).toBeEnabled();

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the word count collapses runs of whitespace and ignores leading/trailing space', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// Irregular spacing (leading/trailing, double spaces, a tab) around exactly
		// three tokens. A correct count trims then splits on whitespace RUNS
		// (`.trim().split(/\s+/)`); a naive `split(' ')` would over-count the empty
		// gaps. Scoped to this submission by its unique leading token.
		const token = uniq('spaced');
		const phrase = `   ${token}    alpha\tbeta   `;
		await page.getByTestId('wc-input').fill(phrase);
		await page.getByTestId('wc-submit').click();

		const row = rowFor(page, token);
		await expect(row).toHaveAttribute('data-status', 'done', { timeout: DONE });
		await expect(row.getByTestId('wc-result')).toHaveText(/^\s*3\s*$/, { timeout: DONE });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('multiple submissions each resolve to their own independent count', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// Three distinct submissions with different word counts, enqueued back to
		// back. Each row must resolve to ITS OWN count — the per-job results must
		// not bleed into one another (each keyed by its own job id).
		const specs = [3, 7, 2].map((n) => ({ n, phrase: phraseWithWords(n) }));
		for (const s of specs) {
			await page.getByTestId('wc-input').fill(s.phrase);
			await page.getByTestId('wc-submit').click();
		}
		for (const s of specs) {
			const row = rowFor(page, s.phrase);
			await expect(row).toHaveAttribute('data-status', 'done', { timeout: DONE });
			await expect(row.getByTestId('wc-result')).toHaveText(new RegExp(`^\\s*${s.n}\\s*$`), { timeout: DONE });
		}

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('multiple finished jobs all persist across a full reload', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const first = phraseWithWords(4);
		const second = phraseWithWords(9);
		for (const phrase of [first, second]) {
			await page.getByTestId('wc-input').fill(phrase);
			await page.getByTestId('wc-submit').click();
		}
		await expect(rowFor(page, first)).toHaveAttribute('data-status', 'done', { timeout: DONE });
		await expect(rowFor(page, second)).toHaveAttribute('data-status', 'done', { timeout: DONE });

		// After a reload BOTH finished jobs must still be present with their counts
		// — persistence must restore the whole list, not just the most recent row.
		await page.reload();
		await expect(rowFor(page, first).getByTestId('wc-result')).toHaveText(/^\s*4\s*$/, { timeout: DONE });
		await expect(rowFor(page, second).getByTestId('wc-result')).toHaveText(/^\s*9\s*$/, { timeout: DONE });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('unicode and emoji tokens each count as one word', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// Five space-separated tokens, including non-ASCII words and an emoji.
		// Whitespace-run splitting counts each as one word (5). An impl built on
		// `\w+` undercounts the unicode/emoji tokens.
		const token = uniq('uni');
		const phrase = `${token} café 日本語 🙂 naïve`;
		await page.getByTestId('wc-input').fill(phrase);
		await page.getByTestId('wc-submit').click();

		const row = rowFor(page, token);
		await expect(row).toHaveAttribute('data-status', 'done', { timeout: DONE });
		await expect(row.getByTestId('wc-result')).toHaveText(/^\s*5\s*$/, { timeout: DONE });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('punctuation is part of a word, not a separator', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// Only whitespace separates words, so these three punctuation-laden tokens
		// count as 3. An impl that splits on `\W+` would over-count.
		const token = uniq('punct');
		const phrase = `${token} hello,world foo.bar-baz!`;
		await page.getByTestId('wc-input').fill(phrase);
		await page.getByTestId('wc-submit').click();

		const row = rowFor(page, token);
		await expect(row).toHaveAttribute('data-status', 'done', { timeout: DONE });
		await expect(row.getByTestId('wc-result')).toHaveText(/^\s*3\s*$/, { timeout: DONE });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a single token counts as exactly one word', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// Boundary case: one token, no internal whitespace. `.trim().split(/\s+/)`
		// is 1; an off-by-one that counts separators would be 0.
		const phrase = uniq('solo');
		await page.getByTestId('wc-input').fill(phrase);
		await page.getByTestId('wc-submit').click();

		const row = rowFor(page, phrase);
		await expect(row).toHaveAttribute('data-status', 'done', { timeout: DONE });
		await expect(row.getByTestId('wc-result')).toHaveText(/^\s*1\s*$/, { timeout: DONE });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a job reloaded while still processing is restored and still resolves to done', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// Submit, then wait only for the row to APPEAR (it may still be
		// "processing"), and reload right away. Because each submission is
		// persisted at enqueue time (keyed by job id), the row must survive the
		// reload and still resolve to "done" with its count — an impl that tracks
		// the job list only in client memory loses this in-flight row.
		const phrase = phraseWithWords(7);
		await page.getByTestId('wc-input').fill(phrase);
		await page.getByTestId('wc-submit').click();
		await expect(rowFor(page, phrase)).toBeVisible({ timeout: APPEAR });

		await page.reload();
		await expect(rowFor(page, phrase)).toHaveAttribute('data-status', 'done', { timeout: DONE });
		await expect(rowFor(page, phrase).getByTestId('wc-result')).toHaveText(/^\s*7\s*$/, { timeout: DONE });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the same text submitted twice yields two independent rows keyed by job id', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// Identical text submitted twice = two independent jobs. Each must get its
		// OWN row and its OWN result (keyed by job id). An impl that keys results
		// by the input text collapses these into one row or shares a single result.
		const phrase = phraseWithWords(6); // unique leading token shared by both rows
		for (let i = 0; i < 2; i++) {
			await page.getByTestId('wc-input').fill(phrase);
			await page.getByTestId('wc-submit').click();
		}

		const rows = rowFor(page, phrase);
		await expect(rows).toHaveCount(2, { timeout: DONE });
		await expect(rows.nth(0)).toHaveAttribute('data-status', 'done', { timeout: DONE });
		await expect(rows.nth(1)).toHaveAttribute('data-status', 'done', { timeout: DONE });
		await expect(rows.nth(0).getByTestId('wc-result')).toHaveText(/^\s*6\s*$/, { timeout: DONE });
		await expect(rows.nth(1).getByTestId('wc-result')).toHaveText(/^\s*6\s*$/, { timeout: DONE });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
