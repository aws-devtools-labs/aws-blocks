// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { isBlocksError, ApiError } from '@aws-blocks/core';
import { FileBucketErrors } from '@aws-blocks/bb-file-bucket';
import type { api as apiType } from 'aws-blocks';

export function fileBucketTests(getApi: () => typeof apiType) {
  describe('FileBucket BB', () => {
    test('FileBucket - put and get', async () => {
      const api = getApi();
      await api.filePut('test/hello.txt', 'hello world', 'text/plain');
      const file = await api.fileGet('test/hello.txt');
      assert.ok(file);
      assert.strictEqual(file.body, 'hello world');
      assert.strictEqual(file.contentType, 'text/plain');
      assert.strictEqual(file.size, 11);
    });

    test('FileBucket - get non-existent returns null', async () => {
      const api = getApi();
      const file = await api.fileGet('test/nonexistent.txt');
      assert.strictEqual(file, null);
    });

    test('FileBucket - put overwrites existing', async () => {
      const api = getApi();
      await api.filePut('test/overwrite.txt', 'v1');
      await api.filePut('test/overwrite.txt', 'v2');
      const file = await api.fileGet('test/overwrite.txt');
      assert.ok(file);
      assert.strictEqual(file.body, 'v2');
    });

    test('FileBucket - delete removes file', async () => {
      const api = getApi();
      await api.filePut('test/to-delete.txt', 'data');
      await api.fileDelete('test/to-delete.txt');
      assert.strictEqual(await api.fileGet('test/to-delete.txt'), null);
    });

    test('FileBucket - delete non-existent is no-op', async () => {
      const api = getApi();
      await api.fileDelete('test/never-existed.txt');
      // Should not throw
    });

    test('FileBucket - deleteBatch removes multiple files', async () => {
      const api = getApi();
      await api.filePut('test/batch-a.txt', 'a');
      await api.filePut('test/batch-b.txt', 'b');
      await api.filePut('test/batch-c.txt', 'c');
      await api.fileDeleteBatch(['test/batch-a.txt', 'test/batch-b.txt']);
      assert.strictEqual(await api.fileGet('test/batch-a.txt'), null);
      assert.strictEqual(await api.fileGet('test/batch-b.txt'), null);
      assert.ok(await api.fileGet('test/batch-c.txt'));
    });

    test('FileBucket - scan lists files', async () => {
      const api = getApi();
      const uid = Date.now().toString(36);
      await api.filePut(`scan-${uid}/a.txt`, 'a');
      await api.filePut(`scan-${uid}/b.txt`, 'b');
      const files = await api.fileScan(`scan-${uid}/`);
      assert.strictEqual(files.length, 2);
      const paths = files.map((f) => f.path).sort();
      assert.ok(paths[0].endsWith('a.txt'));
      assert.ok(paths[1].endsWith('b.txt'));
    });

    test('FileBucket - scan with prefix filters results', async () => {
      const api = getApi();
      const uid = Date.now().toString(36);
      await api.filePut(`prefix-${uid}/uploads/a.txt`, 'a');
      await api.filePut(`prefix-${uid}/reports/b.txt`, 'b');
      const files = await api.fileScan(`prefix-${uid}/uploads/`);
      assert.strictEqual(files.length, 1);
      assert.ok(files[0].path.includes('a.txt'));
    });

    test('FileBucket - metadata preserved', async () => {
      const api = getApi();
      await api.filePut('test/meta.txt', 'data', 'text/csv');
      const file = await api.fileGet('test/meta.txt');
      assert.ok(file);
      assert.strictEqual(file.contentType, 'text/csv');
    });

    test('FileBucket - default contentType is application/octet-stream', async () => {
      const api = getApi();
      await api.filePut('test/no-type.bin', 'data');
      const file = await api.fileGet('test/no-type.bin');
      assert.ok(file);
      assert.strictEqual(file.contentType, 'application/octet-stream');
    });

    test('FileBucket - nested paths work', async () => {
      const api = getApi();
      await api.filePut('test/a/b/c/deep.txt', 'nested');
      const file = await api.fileGet('test/a/b/c/deep.txt');
      assert.ok(file);
      assert.strictEqual(file.body, 'nested');
    });

    test('FileBucket - getUrl returns a functional presigned URL', async () => {
      const api = getApi();
      await api.filePut('test/presigned-get.txt', 'presigned content', 'text/plain');
      const url = await api.fileGetUrl('test/presigned-get.txt');
      assert.ok(typeof url === 'string');
      const res = await fetch(url);
      assert.strictEqual(res.status, 200);
      const body = await res.text();
      assert.strictEqual(body, 'presigned content');
    });

    test('FileBucket - putUrl returns a functional presigned URL', async () => {
      const api = getApi();
      const url = await api.filePutUrl('test/presigned-put.txt');
      assert.ok(typeof url === 'string');
      // putUrl() without a contentType signs application/octet-stream, so the
      // upload must send exactly that Content-Type (fetch would otherwise send
      // text/plain for a string body, and S3 / the dev server would answer 403).
      const res = await fetch(url, {
        method: 'PUT',
        body: 'uploaded via url',
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      assert.strictEqual(res.status, 200);
      const file = await api.fileVerifyUploaded('test/presigned-put.txt');
      assert.ok(file);
      assert.strictEqual(file.body, 'uploaded via url');
    });

    test('FileBucket - getFileHandle returns a download handle', async () => {
      const api = getApi();
      await api.filePut('test/handle-dl.txt', 'handle download', 'text/plain');
      const handle = await api.fileGetHandle('test/handle-dl.txt');
      assert.ok(handle);
      assert.ok(typeof handle.download === 'function');
      assert.ok(typeof handle.getUrl === 'function');
    });

    test('FileBucket - createUploadHandle returns an upload handle', async () => {
      const api = getApi();
      const handle = await api.fileCreateUploadHandle('test/handle-up.txt', 'text/plain');
      assert.ok(handle);
      assert.ok(typeof handle.upload === 'function');
      assert.ok(typeof handle.getUrl === 'function');
    });

    test('FileBucket - upload handle writes file via presigned URL', async () => {
      const api = getApi();
      const handle = await api.fileCreateUploadHandle('test/handle-uploaded.txt', 'text/plain');
      await handle.upload(new Blob(['handle upload content']));
      const file = await api.fileVerifyUploaded('test/handle-uploaded.txt');
      assert.ok(file);
      assert.strictEqual(file.body, 'handle upload content');
    });

    test('FileBucket - download handle fetches file content', async () => {
      const api = getApi();
      await api.filePut('test/handle-fetch.txt', 'fetch me', 'text/plain');
      const handle = await api.fileGetHandle('test/handle-fetch.txt');
      const url = handle.getUrl();
      const res = await fetch(url);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(await res.text(), 'fetch me');
    });

    // ── Request validation, signed upload headers and download disposition ─
    //
    // These run over the wire against the dev server (mock) and real S3
    // (sandbox), so a rejection must reach the client as a 400 ValidationFailed,
    // and a presigned URL must enforce what it signed in both environments.

    /** A `ValidationFailed` the RPC layer answered with HTTP 400. */
    const isValidation400 = (e: unknown): boolean => {
      assert.ok(e instanceof ApiError, `Expected ApiError, got ${e}`);
      assert.strictEqual(e.status, 400, 'ValidationFailed must be 400, not 500');
      assert.ok(isBlocksError(e, 'ValidationFailed'), `Expected ValidationFailed, got ${e.name}`);
      return true;
    };

    describe('request validation over the wire', () => {
      test('an invalid key returns ValidationFailed (400)', async () => {
        const api = getApi();
        await assert.rejects(() => api.fileGet('a/../b'), isValidation400);
        await assert.rejects(() => api.filePut('a/../b', 'x'), isValidation400);
      });

      test('an invalid scan prefix returns ValidationFailed (400)', async () => {
        const api = getApi();
        await assert.rejects(() => api.fileScan('a/../'), isValidation400);
      });

      test('a contentType that is not a single media type returns ValidationFailed (400)', async () => {
        const api = getApi();
        await assert.rejects(
          () => api.filePutUrlWithOptions('test/ct-list.txt', { contentType: 'text/plain, text/html' }),
          isValidation400,
        );
        await assert.rejects(() => api.filePut('test/ct-list.txt', 'x', 'text/plain, text/html'), isValidation400);
      });

      test('allowedContentTypes and maxUploadBytes reject with ValidationFailed (400)', async () => {
        const api = getApi();
        await assert.rejects(
          () => api.constrainedFilePutUrl('test/c.html', { contentType: 'text/html', contentLength: 1 }),
          isValidation400,
        );
        await assert.rejects(
          () => api.constrainedFilePutUrl('test/c.png', { contentType: 'image/png, text/html', contentLength: 1 }),
          isValidation400,
        );
        await assert.rejects(() => api.constrainedFilePutUrl('test/c.txt', { contentType: 'text/plain' }), isValidation400);
        await assert.rejects(
          () => api.constrainedFilePutUrl('test/c.txt', { contentType: 'text/plain', contentLength: 1025 }),
          isValidation400,
        );
        await assert.rejects(() => api.constrainedFilePut('test/c.html', 'x', 'text/html'), isValidation400);
      });

      test('a constrained bucket accepts an allowed upload of the signed size', async () => {
        const api = getApi();
        const body = 'constrained';
        const url = await api.constrainedFilePutUrl('test/constrained.txt', {
          contentType: 'text/plain',
          contentLength: body.length,
        });
        const res = await fetch(url, { method: 'PUT', body, headers: { 'Content-Type': 'text/plain' } });
        assert.strictEqual(res.status, 200);
        const file = await api.constrainedFileGet('test/constrained.txt');
        assert.ok(file);
        assert.strictEqual(file.body, body);
        assert.strictEqual(file.contentType, 'text/plain');
      });
    });

    describe('presigned uploads enforce the signed headers', () => {
      test('a different Content-Type than the signed one is rejected (403)', async () => {
        const api = getApi();
        const url = await api.filePutUrlWithOptions('test/signed-type.txt', { contentType: 'text/plain' });
        const res = await fetch(url, { method: 'PUT', body: 'x', headers: { 'Content-Type': 'text/html' } });
        assert.strictEqual(res.status, 403);
        assert.strictEqual(await api.fileGet('test/signed-type.txt'), null);
      });

      test('a body of a different size than the signed contentLength is rejected', async () => {
        const api = getApi();
        const url = await api.filePutUrlWithOptions('test/signed-length.txt', { contentType: 'text/plain', contentLength: 5 });
        const res = await fetch(url, {
          method: 'PUT',
          body: 'longer than five bytes',
          headers: { 'Content-Type': 'text/plain' },
        });
        assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
        assert.strictEqual(await api.fileGet('test/signed-length.txt'), null);
      });

      test('a body of exactly the signed contentLength is accepted', async () => {
        const api = getApi();
        const url = await api.filePutUrlWithOptions('test/signed-length-ok.txt', { contentType: 'text/plain', contentLength: 5 });
        const res = await fetch(url, { method: 'PUT', body: 'exact', headers: { 'Content-Type': 'text/plain' } });
        assert.strictEqual(res.status, 200);
        const file = await api.fileGet('test/signed-length-ok.txt');
        assert.ok(file);
        assert.strictEqual(file.body, 'exact');
      });

      test('an upload handle created without contentType uploads via the hydrated handle', async () => {
        const api = getApi();
        const handle = await api.fileCreateUploadHandle('test/handle-default-type.bin');
        await handle.upload(new Blob(['default type upload']));
        const file = await api.fileVerifyUploaded('test/handle-default-type.bin');
        assert.ok(file);
        assert.strictEqual(file.body, 'default type upload');
        assert.strictEqual(file.contentType, 'application/octet-stream');
      });
    });

    test('FileBucket - getUrl({ attachment }) serves Content-Disposition: attachment', async () => {
      const api = getApi();
      await api.filePut('test/attachment.txt', 'download me', 'text/plain');
      const url = await api.fileGetUrlAttachment('test/attachment.txt', 'report.txt');
      const res = await fetch(url);
      assert.strictEqual(res.status, 200);
      const disposition = res.headers.get('content-disposition') ?? '';
      assert.ok(disposition.includes('attachment'), disposition);
      assert.ok(disposition.includes('report.txt'), disposition);
      assert.strictEqual(await res.text(), 'download me');
    });

    // ── Filepath pollution: user keys that look like internal markers ─────
    //
    // The mock segregates internal data into content/, meta/, and versions/
    // roots so a user key like "data.__meta__.json" or one containing
    // "__versions__" is stored verbatim and never confused with bookkeeping.
    // S3 has no such markers, so these must round-trip identically in both
    // environments — this is a mock/S3 parity guarantee.

    describe('filepath pollution', () => {
      test('key ending in .__meta__.json round-trips and appears in scan', async () => {
        const api = getApi();
        const uid = Date.now().toString(36);
        const key = `pollute-${uid}/data.__meta__.json`;
        await api.filePut(key, 'user owns this name', 'application/json');

        const file = await api.fileGet(key);
        assert.ok(file, 'user file with .__meta__.json name must be retrievable');
        assert.strictEqual(file.body, 'user owns this name');
        assert.strictEqual(file.contentType, 'application/json');

        const files = await api.fileScan(`pollute-${uid}/`);
        const paths = files.map((f) => f.path);
        assert.ok(
          paths.some((p) => p.endsWith('data.__meta__.json')),
          `scan() must list the user file. Got: ${JSON.stringify(paths)}`,
        );
      });

      test('key containing __versions__ round-trips and appears in scan', async () => {
        const api = getApi();
        const uid = Date.now().toString(36);
        const key = `pollute-${uid}/logs/__versions__/report.csv`;
        await api.filePut(key, 'col1,col2', 'text/csv');

        const file = await api.fileGet(key);
        assert.ok(file, 'user file under a __versions__ path must be retrievable');
        assert.strictEqual(file.body, 'col1,col2');

        const files = await api.fileScan(`pollute-${uid}/`);
        const paths = files.map((f) => f.path);
        assert.ok(
          paths.some((p) => p.endsWith('__versions__/report.csv')),
          `scan() must list the file under a __versions__ path. Got: ${JSON.stringify(paths)}`,
        );
      });
    });

    // ── Error paths ───────────────────────────────────────────────────────
    //
    // restoreVersion against a non-existent version rejects in both the mock
    // and S3, so it runs everywhere.

    describe('error paths', () => {
      test('restoreVersion on an unknown versionId rejects with NoSuchVersion', async () => {
        const api = getApi();
        await api.vFilePut('err/restore-bad.txt', 'only version');
        // Assert the *name*, not just that it rejects: S3 raises InvalidRequest
        // for an unresolvable versionId on CopyObject (never NoSuchVersion), so a
        // guard that only matched NoSuchVersion would leak the raw error here. The
        // BB must map it to a clean, matchable NoSuchVersion in both runtimes.
        await assert.rejects(
          () => api.vFileRestoreVersion('err/restore-bad.txt', 'v9999-does-not-exist'),
          (e: unknown) => isBlocksError(e, FileBucketErrors.VersionNotFound),
        );
      });

      test('get on an unknown versionId returns null (matches the mock; no throw)', async () => {
        const api = getApi();
        await api.vFilePut('err/get-bad.txt', 'only version');
        // S3 raises InvalidArgument ("Invalid version id specified") for an
        // unresolvable versionId on GetObject — the BB must fold that to null to
        // match the mock, rather than throwing. No cross-runtime coverage existed
        // for the get() half before.
        const result = await api.vFileGet('err/get-bad.txt', 'v9999-does-not-exist');
        assert.strictEqual(result, null);
      });
    });

    // Note: path-traversal rejection (e.g. put('../escape.txt')) is a mock-only
    // guard — S3 accepts ".." as a literal key segment — so it is covered by the
    // unit tests (src/path-containment.test.ts), not here, to keep this suite's
    // behavior identical across local/sandbox/production. See DESIGN.md parity gaps.

    // ── Versioned FileBucket ──────────────────────────────────────────────

    describe('Versioned', () => {
      test('deleting a version of a prefix key does not delete nested objects', async () => {
        const api = getApi();
        const prefix = `v/prefix-delete-${crypto.randomUUID()}`;
        const children = ['readme.txt', 'v999'];
        try {
          for (const child of children) {
            await api.vFilePut(`${prefix}/${child}`, 'nested');
            await api.vFileDelete(prefix, child);
            assert.strictEqual((await api.vFileGet(`${prefix}/${child}`))?.body, 'nested');
            assert.strictEqual((await api.vFileListVersions(`${prefix}/${child}`)).length, 1);
          }
          assert.deepStrictEqual(await api.vFileListVersions(prefix), []);
        } finally {
          for (const child of children) await api.vFilePurge(`${prefix}/${child}`);
        }
      });

      test('deleting the current version promotes the previous version through the API', async () => {
        const api = getApi();
        const path = `v/delete-current-${crypto.randomUUID()}.txt`;
        try {
          await api.vFilePut(path, 'old', 'text/plain');
          await api.vFilePut(path, 'new content', 'text/csv');
          const [latest, previous] = await api.vFileListVersions(path);
          await api.vFileDelete(path, latest.versionId);
          const file = await api.vFileGet(path);
          assert.ok(file);
          assert.strictEqual(file.body, 'old');
          assert.strictEqual(file.contentType, 'text/plain');
          assert.strictEqual(file.size, 3);
          assert.strictEqual(await api.vFileGet(path, latest.versionId), null);
          const remaining = await api.vFileListVersions(path);
          assert.strictEqual(remaining.length, 1);
          assert.strictEqual(remaining[0].versionId, previous.versionId);
          assert.strictEqual(remaining[0].isCurrent, true);
          const files = await api.vFileScan(path);
          assert.strictEqual(files.length, 1);
          assert.strictEqual(files[0].size, 3);
        } finally {
          await api.vFilePurge(path);
        }
      });

      test('permanently deleting every version removes the object from reads and scans', async () => {
        const api = getApi();
        const path = `v/delete-all-${crypto.randomUUID()}.txt`;
        try {
          await api.vFilePut(path, 'old');
          await api.vFilePut(path, 'new content');
          const versions = await api.vFileListVersions(path);
          for (const version of versions) await api.vFileDelete(path, version.versionId);
          assert.deepStrictEqual(await api.vFileListVersions(path), []);
          assert.strictEqual(await api.vFileGet(path), null);
          assert.deepStrictEqual(await api.vFileScan(path), []);
        } finally {
          await api.vFilePurge(path);
        }
      });

      // Clean up any leftover versions from previous runs
      test.before(async () => {
        const api = getApi();
        const paths = ['v/doc.txt', 'v/list.txt', 'v/specific.txt', 'v/del.txt', 'v/permdel.txt', 'v/restore.txt', 'v/scan-a.txt', 'v/scan-b.txt'];
        await Promise.all(paths.map(p => api.vFilePurge(p)));
      });

      test('put creates versions, get returns latest', async () => {
        const api = getApi();
        await api.vFilePut('v/doc.txt', 'v1');
        await api.vFilePut('v/doc.txt', 'v2');
        const file = await api.vFileGet('v/doc.txt');
        assert.ok(file);
        assert.strictEqual(file.body, 'v2');
      });

      test('listVersions returns all versions newest-first', async () => {
        const api = getApi();
        await api.vFilePut('v/list.txt', 'a');
        await api.vFilePut('v/list.txt', 'b');
        await api.vFilePut('v/list.txt', 'c');
        const versions = await api.vFileListVersions('v/list.txt');
        assert.strictEqual(versions.length, 3);
        assert.strictEqual(versions[0].isCurrent, true);
      });

      test('get with versionId returns specific version', async () => {
        const api = getApi();
        await api.vFilePut('v/specific.txt', 'first');
        await api.vFilePut('v/specific.txt', 'second');
        const versions = await api.vFileListVersions('v/specific.txt');
        const oldest = versions[versions.length - 1];
        const file = await api.vFileGet('v/specific.txt', oldest.versionId);
        assert.ok(file);
        assert.strictEqual(file.body, 'first');
      });

      test('delete without versionId places delete marker', async () => {
        const api = getApi();
        await api.vFilePut('v/del.txt', 'data');
        await api.vFileDelete('v/del.txt');
        assert.strictEqual(await api.vFileGet('v/del.txt'), null);
        const versions = await api.vFileListVersions('v/del.txt');
        assert.ok(versions.length > 0);
      });

      test('delete with versionId permanently removes that version', async () => {
        const api = getApi();
        await api.vFilePut('v/permdel.txt', 'v1');
        await api.vFilePut('v/permdel.txt', 'v2');
        const versions = await api.vFileListVersions('v/permdel.txt');
        await api.vFileDelete('v/permdel.txt', versions[1].versionId);
        const remaining = await api.vFileListVersions('v/permdel.txt');
        assert.strictEqual(remaining.length, 1);
      });

      test('restoreVersion makes old version current', async () => {
        const api = getApi();
        await api.vFilePut('v/restore.txt', 'original');
        await api.vFilePut('v/restore.txt', 'updated');
        const versions = await api.vFileListVersions('v/restore.txt');
        const oldest = versions[versions.length - 1];
        await api.vFileRestoreVersion('v/restore.txt', oldest.versionId);
        const file = await api.vFileGet('v/restore.txt');
        assert.ok(file);
        assert.strictEqual(file.body, 'original');
      });

      test('a presigned URL returns 404 after its version is permanently deleted', async () => {
        const api = getApi();
        const key = `v/deleted-download-${Date.now()}.txt`;
        await api.vFilePut(key, 'old content', 'text/csv');
        await api.vFilePut(key, 'current content', 'text/plain');
        const versions = await api.vFileListVersions(key);
        const old = versions[versions.length - 1];
        const url = await api.vFileGetUrl(key, old.versionId);
        const before = await fetch(url);
        assert.strictEqual(before.status, 200);
        assert.strictEqual(await before.text(), 'old content');

        await api.vFileDelete(key, old.versionId);
        assert.strictEqual(await api.vFileGet(key, old.versionId), null);
        const deleted = await fetch(url);
        assert.strictEqual(deleted.status, 404);
        await deleted.text();

        const current = await fetch(await api.vFileGetUrl(key));
        assert.strictEqual(current.status, 200);
        assert.strictEqual(current.headers.get('content-type'), 'text/plain');
        assert.strictEqual(await current.text(), 'current content');
      });

      test('scan skips deleted files', async () => {
        const api = getApi();
        await api.vFilePut('v/scan-a.txt', 'a');
        await api.vFilePut('v/scan-b.txt', 'b');
        await api.vFileDelete('v/scan-a.txt');
        const files = await api.vFileScan('v/scan-');
        assert.strictEqual(files.length, 1);
        assert.ok(files[0].path.includes('scan-b.txt'));
      });
    });
  });
}
