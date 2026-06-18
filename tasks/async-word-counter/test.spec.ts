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
});
