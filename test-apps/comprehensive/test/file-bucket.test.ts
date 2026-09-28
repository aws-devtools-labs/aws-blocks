// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { isBlocksError } from '@aws-blocks/core';
import type { api as apiType } from 'aws-blocks';

// FileBucketErrors.VersionNotFound — matched by name across the RPC wire.
const VersionNotFound = 'NoSuchVersion';

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
      const res = await fetch(url, { method: 'PUT', body: 'uploaded via url' });
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
          (e: unknown) => isBlocksError(e, VersionNotFound),
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
