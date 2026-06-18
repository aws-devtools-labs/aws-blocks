import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const T = 8_000;

const RUN = process.env.RUN_ID || String(Date.now());
let seq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++seq}-${Date.now()}`;

// Per-test no-error gate: ONLY uncaught page errors (not console warnings, not
// 4xx/5xx responses).
function watchErrors(page: Page, sink: string[] = []): string[] {
	page.on('pageerror', (err) => sink.push(String(err)));
	return sink;
}

// Scope to exactly the row whose file-name renders `name` — never a global count.
const itemFor = (page: Page, name: string) =>
	page.getByTestId('file-item').filter({ has: page.getByTestId('file-name').filter({ hasText: name }) });

async function upload(page: Page, name: string, body = 'hello blocks file gallery'): Promise<void> {
	await page.getByTestId('file-input').setInputFiles({
		name,
		mimeType: 'text/plain',
		buffer: Buffer.from(body),
	});
	await page.getByTestId('file-upload').click();
	await expect(itemFor(page, name)).toHaveCount(1, { timeout: T });
}

test.describe('file-gallery', () => {
	test('shows the upload input and the file list', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await expect(page.getByTestId('file-input')).toBeVisible();
		// The list container must exist on load, but an empty list may reasonably be
		// hidden (e.g. swapped for an empty-state), so assert presence — not
		// visibility. Visibility is asserted after an upload (next test).
		await expect(page.getByTestId('file-list')).toHaveCount(1);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('uploading a file lists it by name', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const name = `${uniq('hello')}.txt`;
		await upload(page, name);
		// With an item present the list is non-empty, so the container must now show.
		await expect(page.getByTestId('file-list')).toBeVisible();
		await expect(itemFor(page, name)).toBeVisible();

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('an uploaded file exposes a resolvable download link', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const name = `${uniq('download')}.txt`;
		await upload(page, name);

		// A real, resolvable href (absolute URL, root-relative path, or blob:) —
		// not a "#" placeholder.
		const href = await itemFor(page, name).getByTestId('file-download').getAttribute('href');
		expect(href, 'download link must have an href').toBeTruthy();
		expect(href).toMatch(/^(https?:\/\/|\/|blob:)/);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('an uploaded file persists across a full reload', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const name = `${uniq('persist')}.txt`;
		await upload(page, name);

		await page.reload();
		await expect(itemFor(page, name)).toHaveCount(1, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('deleting a file removes it, and the deletion survives a reload', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const name = `${uniq('delete')}.txt`;
		await upload(page, name);

		await itemFor(page, name).getByTestId('file-delete').click();
		await expect(itemFor(page, name)).toHaveCount(0, { timeout: T });

		await page.reload();
		await expect(itemFor(page, name)).toHaveCount(0, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('two uploaded files coexist in the list', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const first = `${uniq('first')}.txt`;
		const second = `${uniq('second')}.txt`;
		await upload(page, first, 'first file body');
		await upload(page, second, 'second file body');

		await expect(itemFor(page, first)).toHaveCount(1, { timeout: T });
		await expect(itemFor(page, second)).toHaveCount(1, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
