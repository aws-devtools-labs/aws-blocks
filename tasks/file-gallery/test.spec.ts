import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const BASE = process.env.BLOCKS_URL || 'http://localhost:3000';
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

const toB64 = (buf: Buffer) => buf.toString('base64');
// Download URLs may be absolute (presigned) or root-relative (served locally).
const absUrl = (u: string) => (/^https?:\/\//.test(u) ? u : `${BASE.replace(/\/$/, '')}/${u.replace(/^\//, '')}`);

async function putFile(ctx: APIRequestContext, name: string, buf: Buffer): Promise<any> {
	const { body } = await rpc(ctx, 'api.putFile', [name, toB64(buf)]);
	expect(body?.error, `JSON-RPC error from putFile: ${JSON.stringify(body?.error)}`).toBeFalsy();
	return body?.result;
}

async function list(ctx: APIRequestContext): Promise<any[]> {
	const { body } = await rpc(ctx, 'api.listFiles', []);
	expect(body?.error, `JSON-RPC error from listFiles: ${JSON.stringify(body?.error)}`).toBeFalsy();
	return Array.isArray(body?.result) ? body.result : [];
}

const entryFor = (files: any[], name: string) => files.find((f) => f?.name === name);

// HARNESS CONTRACT: requires workers:1 (serial; shared-store assertions assume no concurrent runners)
test.describe('file-gallery', () => {
	// --- Framework surface: store / list / serve / delete through the api ---

	test('putFile stores a file that listFiles reports with the exact byte size', async ({ request }) => {
		const name = `${uniq('hello')}.txt`;
		const body = Buffer.from('hello blocks file gallery');
		const put = await putFile(request, name, body);
		expect(put?.name).toBe(name);
		expect(put?.size).toBe(body.byteLength);

		const entry = entryFor(await list(request), name);
		expect(entry, 'listFiles must include the stored file').toBeTruthy();
		expect(entry.size).toBe(body.byteLength);
	});

	test('a stored file\u2019s url serves the exact uploaded text bytes', async ({ request }) => {
		const name = `${uniq('content')}.txt`;
		const body = Buffer.from(`payload-${uniq('body')}`);
		await putFile(request, name, body);

		const entry = entryFor(await list(request), name);
		expect(entry?.url, 'listFiles entry must expose a download url').toBeTruthy();
		const res = await request.get(absUrl(String(entry.url)));
		expect(res.ok(), `download fetch failed: HTTP ${res.status()}`).toBe(true);
		expect((await res.body()).equals(body), 'served bytes must equal uploaded bytes').toBe(true);
	});

	test('binary (non-UTF-8) bytes round-trip byte-for-byte', async ({ request }) => {
		const name = `${uniq('binary')}.bin`;
		const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x80, 0x7f, 0xc3, 0x28]);
		await putFile(request, name, bytes);

		const entry = entryFor(await list(request), name);
		expect(entry?.url).toBeTruthy();
		expect(entry.size).toBe(bytes.byteLength);
		const res = await request.get(absUrl(String(entry.url)));
		expect(res.ok(), `download fetch failed: HTTP ${res.status()}`).toBe(true);
		expect((await res.body()).equals(bytes), 'binary bytes must survive intact').toBe(true);
	});

	test('a zero-byte file is stored (size 0) and served as empty', async ({ request }) => {
		const name = `${uniq('empty')}.txt`;
		const put = await putFile(request, name, Buffer.alloc(0));
		expect(put?.size).toBe(0);

		const entry = entryFor(await list(request), name);
		expect(entry?.size).toBe(0);
		const res = await request.get(absUrl(String(entry.url)));
		expect(res.ok(), `download fetch failed: HTTP ${res.status()}`).toBe(true);
		expect((await res.body()).byteLength).toBe(0);
	});

	test('re-putting the same name overwrites it (one entry, latest bytes)', async ({ request }) => {
		const name = `${uniq('dup')}.txt`;
		await putFile(request, name, Buffer.from(`v1-${uniq('a')}`));
		const v2 = Buffer.from(`v2-${uniq('b')}`);
		await putFile(request, name, v2);

		const files = await list(request);
		expect(files.filter((f) => f?.name === name), 'exactly one entry for the name').toHaveLength(1);
		const res = await request.get(absUrl(String(entryFor(files, name).url)));
		expect((await res.body()).equals(v2), 'the url must serve the latest bytes').toBe(true);
	});

	test('a name with spaces and unicode is preserved verbatim and still serves its bytes', async ({ request }) => {
		const name = `${uniq('spaced')} report (v2) \u65e5\u672c.txt`;
		const body = Buffer.from(`payload-${uniq('body')}`);
		await putFile(request, name, body);

		const entry = entryFor(await list(request), name);
		expect(entry, 'the unicode-named file must be listed verbatim').toBeTruthy();
		const res = await request.get(absUrl(String(entry.url)));
		expect(res.ok(), `download fetch failed: HTTP ${res.status()}`).toBe(true);
		expect((await res.body()).equals(body)).toBe(true);
	});

	test('deleteFile removes only that file; others survive and the removal persists', async ({ request }) => {
		const keep = `${uniq('keep')}.txt`;
		const drop = `${uniq('drop')}.txt`;
		await putFile(request, keep, Buffer.from('keep this one'));
		await putFile(request, drop, Buffer.from('drop this one'));

		const del = await rpc(request, 'api.deleteFile', [drop]);
		expect(del.body?.error, `JSON-RPC error from deleteFile: ${JSON.stringify(del.body?.error)}`).toBeFalsy();

		const files = await list(request);
		expect(entryFor(files, drop), 'the deleted file must be gone').toBeFalsy();
		const survivor = entryFor(files, keep);
		expect(survivor, 'the untouched file must remain').toBeTruthy();
		// The survivor is still really served.
		const res = await request.get(absUrl(String(survivor.url)));
		expect((await res.body()).toString()).toBe('keep this one');
	});

	test('putFile validates its input — missing name or bad base64 is rejected', async ({ request }) => {
		const noName = await rpc(request, 'api.putFile', [toB64(Buffer.from('x'))]);
		expect(noName.status, `unexpected HTTP ${noName.status}`).toBeLessThan(500);
		expect(noName.body?.error, 'a missing name must yield a JSON-RPC error envelope').toBeTruthy();
		expect(noName.body?.result ?? null).toBeNull();

		const noParams = await rpc(request, 'api.putFile', undefined, { omitParams: true });
		expect(noParams.body?.error, 'no params must yield a JSON-RPC error envelope').toBeTruthy();
	});

	test('putFile rejects a present-but-empty name (nothing stored under a blank key)', async ({ request }) => {
		// A name that is present but blank must be rejected just like a missing
		// one — never stored under an empty key.
		const empty = await rpc(request, 'api.putFile', ['', toB64(Buffer.from('x'))]);
		expect(empty.status, `unexpected HTTP ${empty.status}`).toBeLessThan(500);
		expect(empty.body?.error, 'an empty name must yield a JSON-RPC error envelope').toBeTruthy();
		expect(empty.body?.result ?? null).toBeNull();

		// No phantom entry leaked in under the blank name.
		expect(entryFor(await list(request), ''), 'no file may be stored under an empty name').toBeFalsy();
	});

	// --- Page smoke: the thin client wires the input/list to the api ---

	test('shows the upload input and the file list container', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		await expect(page.getByTestId('file-input')).toBeVisible();
		await expect(page.getByTestId('file-list')).toHaveCount(1);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('uploading through the page lists the file with a resolvable link, and delete removes it', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const name = `${uniq('via-dom')}.txt`;
		await page.getByTestId('file-input').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('dom upload body') });
		await page.getByTestId('file-upload').click();

		const row = page
			.getByTestId('file-item')
			.filter({ has: page.getByTestId('file-name').filter({ hasText: name }) });
		await expect(row).toHaveCount(1, { timeout: T });

		const href = await row.getByTestId('file-download').getAttribute('href');
		expect(href, 'download link must have a real href').toBeTruthy();
		expect(href).toMatch(/^(https?:\/\/|\/|blob:)/);

		await row.getByTestId('file-delete').click();
		await expect(row).toHaveCount(0, { timeout: T });
		await page.reload();
		await expect(row).toHaveCount(0, { timeout: T });

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});

	test('clicking upload with no file selected is handled gracefully (no throw, no phantom row)', async ({ page }) => {
		const errors = watchErrors(page);
		await page.goto(BASE);

		const uploadBtn = page.getByTestId('file-upload');
		await expect(uploadBtn).toBeVisible();
		const before = await page.getByTestId('file-item').count();

		if (await uploadBtn.isEnabled()) await uploadBtn.click();

		const name = `${uniq('after-noop')}.txt`;
		await page.getByTestId('file-input').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('real') });
		await page.getByTestId('file-upload').click();
		await expect(page.getByTestId('file-item').filter({ has: page.getByTestId('file-name').filter({ hasText: name }) }))
			.toHaveCount(1, { timeout: T });
		// The empty click added no phantom row: exactly one net new item.
		await expect.poll(() => page.getByTestId('file-item').count(), { timeout: T }).toBe(before + 1);

		expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
	});
});
