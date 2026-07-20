import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.BLOCKS_URL ?? 'http://localhost:3000';
const T = 8_000;

const RUN = process.env.RUN_ID || String(Date.now());
let seq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++seq}-${Date.now()}`;

// Per-test no-error gate: uncaught page errors and genuine console errors (not console warnings, not
// 4xx/5xx responses).
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

	test('the download link serves the exact uploaded bytes', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const name = `${uniq('content')}.txt`;
		const body = `payload-${uniq('body')}`;
		await upload(page, name, body);

		const href = await itemFor(page, name).getByTestId('file-download').getAttribute('href');
		expect(href, 'download link must have an href').toBeTruthy();

		// Fetch the link from the page context (same-origin object URL) and confirm
		// it returns the exact bytes uploaded — proving the file was really stored
		// and served, not merely listed by name.
		const served = await page.evaluate(async (u) => {
			const r = await fetch(u as string);
			return { ok: r.ok, text: await r.text() };
		}, href);
		expect(served.ok, `download fetch failed for ${href}`).toBe(true);
		expect(served.text).toBe(body);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('deleting one of two files leaves the other intact (and the split survives reload)', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const keep = `${uniq('keep')}.txt`;
		const drop = `${uniq('drop')}.txt`;
		await upload(page, keep, 'keep this one');
		await upload(page, drop, 'drop this one');

		// Delete only `drop`; the targeted delete must not touch `keep`.
		await itemFor(page, drop).getByTestId('file-delete').click();
		await expect(itemFor(page, drop)).toHaveCount(0, { timeout: T });
		await expect(itemFor(page, keep)).toHaveCount(1, { timeout: T });

		// The deletion and the survivor both persist across a reload.
		await page.reload();
		await expect(itemFor(page, drop)).toHaveCount(0, { timeout: T });
		await expect(itemFor(page, keep)).toHaveCount(1, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('attempting to upload with no file selected is handled gracefully', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const uploadBtn = page.getByTestId('file-upload');
		await expect(uploadBtn).toBeVisible();

		// Baseline count (the bucket persists across tests in this run).
		const before = await page.getByTestId('file-item').count();

		// No file chosen: a correct impl either disables the button or no-ops on
		// click — it must NOT throw (e.g. reading files[0] of an empty selection).
		if (await uploadBtn.isEnabled()) {
			await uploadBtn.click();
		}

		// A subsequent real upload must add EXACTLY ONE row — proving the empty
		// click neither crashed the app nor inserted a phantom row (which would
		// land this at before + 2).
		const name = `${uniq('after-noop')}.txt`;
		await upload(page, name);
		await expect.poll(() => page.getByTestId('file-item').count(), { timeout: T }).toBe(before + 1);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('the download link serves binary (non-UTF8) bytes intact', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const name = `${uniq('binary')}.bin`;
		// Bytes that are NOT valid UTF-8 text (NUL, 0xFF/0xFE, PNG magic, high
		// bytes). A store/serve path that round-trips through a UTF-8 string would
		// corrupt these; only a true binary store survives byte-for-byte.
		const bytes = [0x00, 0x01, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x80, 0x7f, 0xc3, 0x28];
		await page.getByTestId('file-input').setInputFiles({
			name,
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(bytes),
		});
		await page.getByTestId('file-upload').click();
		await expect(itemFor(page, name)).toHaveCount(1, { timeout: T });

		const href = await itemFor(page, name).getByTestId('file-download').getAttribute('href');
		expect(href, 'download link must have an href').toBeTruthy();
		const served = await page.evaluate(async (u) => {
			const r = await fetch(u as string);
			return { ok: r.ok, bytes: Array.from(new Uint8Array(await r.arrayBuffer())) };
		}, href);
		expect(served.ok, `download fetch failed for ${href}`).toBe(true);
		expect(served.bytes).toEqual(bytes);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a filename with spaces and unicode lists verbatim and still serves its bytes', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		// Spaces, parentheses and non-ASCII characters in the name — these need
		// careful key/URL handling. The row must show the name and the link must
		// still resolve to the exact bytes.
		const token = uniq('spaced');
		const name = `${token} report (v2) 日本.txt`;
		const body = `payload-${uniq('body')}`;
		await page.getByTestId('file-input').setInputFiles({
			name,
			mimeType: 'text/plain',
			buffer: Buffer.from(body),
		});
		await page.getByTestId('file-upload').click();

		const row = page
			.getByTestId('file-item')
			.filter({ has: page.getByTestId('file-name').filter({ hasText: token }) });
		await expect(row).toHaveCount(1, { timeout: T });
		await expect(row.getByTestId('file-name')).toContainText('日本', { timeout: T });

		const href = await row.getByTestId('file-download').getAttribute('href');
		expect(href, 'download link must have an href').toBeTruthy();
		const served = await page.evaluate(async (u) => {
			const r = await fetch(u as string);
			return { ok: r.ok, text: await r.text() };
		}, href);
		expect(served.ok, `download fetch failed for ${href}`).toBe(true);
		expect(served.text).toBe(body);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('a zero-byte file is stored and served as empty', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const name = `${uniq('empty')}.txt`;
		// A selected-but-empty file must still upload and list (only the *no
		// selection* case is skipped). An impl that guards on `file.size > 0`
		// would silently drop this file.
		await page.getByTestId('file-input').setInputFiles({
			name,
			mimeType: 'text/plain',
			buffer: Buffer.from(''),
		});
		await page.getByTestId('file-upload').click();
		await expect(itemFor(page, name)).toHaveCount(1, { timeout: T });

		const href = await itemFor(page, name).getByTestId('file-download').getAttribute('href');
		expect(href, 'download link must have an href').toBeTruthy();
		const served = await page.evaluate(async (u) => {
			const r = await fetch(u as string);
			return { ok: r.ok, text: await r.text() };
		}, href);
		expect(served.ok, `download fetch failed for ${href}`).toBe(true);
		expect(served.text).toBe('');

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('re-uploading the same filename overwrites it (one row, latest bytes)', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const name = `${uniq('dup')}.txt`;
		const v1 = `v1-${uniq('a')}`;
		const v2 = `v2-${uniq('b')}`;
		await upload(page, name, v1);

		// Second upload of the SAME name, inline (the helper's count-based wait
		// would pass early off the v1 row). We settle on the SERVED bytes instead.
		await page.getByTestId('file-input').setInputFiles({
			name,
			mimeType: 'text/plain',
			buffer: Buffer.from(v2),
		});
		await page.getByTestId('file-upload').click();

		// Poll the served content of the (single) row until it reflects v2 — this
		// deterministically waits for the overwrite to round-trip. (An append-style
		// impl yields two rows, so the scoped link is ambiguous and never resolves
		// to v2 here — and the explicit count assertion below also fails it.)
		await expect
			.poll(
				async () => {
					try {
						const h = await itemFor(page, name).getByTestId('file-download').getAttribute('href');
						if (!h) return null;
						return await page.evaluate(async (u) => {
							try {
								const r = await fetch(u as string);
								return r.ok ? await r.text() : null;
							} catch {
								return null;
							}
						}, h);
					} catch {
						return null;
					}
				},
				{ timeout: T },
			)
			.toBe(v2);

		await expect(itemFor(page, name)).toHaveCount(1, { timeout: T });

		await page.reload();
		await expect(itemFor(page, name)).toHaveCount(1, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('three uploaded files all persist across a reload', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const names = [`${uniq('p1')}.txt`, `${uniq('p2')}.txt`, `${uniq('p3')}.txt`];
		for (const n of names) await upload(page, n, `body-${n}`);

		await page.reload();
		for (const n of names) await expect(itemFor(page, n)).toHaveCount(1, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
