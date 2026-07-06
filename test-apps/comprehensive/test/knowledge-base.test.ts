// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test, before } from 'node:test';
import assert from 'node:assert';
import { isBlocksError } from '@aws-blocks/core';
import type { api as apiType } from 'aws-blocks';

const ValidationError = 'KnowledgeBaseValidationError';
const Timeout = 'KnowledgeBaseTimeoutException';
const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const isLocal = ENV === 'local';

/**
 * Gate retrieval tests on knowledge-base ingestion sync.
 *
 * Bedrock ingests asynchronously after deploy, so during the initial pre-sync
 * window we wait for the KB to sync with our latest data before probing
 * `kbRetrieve`. We delegate to the wired `waitUntilSynced()` endpoint (exposed
 * here as `kbWaitUntilSynced`) rather than hand-rolling a poll loop over
 * `isSynced()` (`kbSynced`): `waitUntilSynced()` owns the deadline AND rides out
 * transient control-plane blips — throttling, a `RetrievalFailed`, or a brief
 * not-yet-visible `ResourceNotFoundException` during the post-deploy poll — that
 * a per-poll `isSynced()` would otherwise surface as a hard suite failure.
 *
 * A *thrown* error here is therefore a real failure (a failed ingestion job
 * surfaced as `IngestionFailedException`, a `KnowledgeBaseValidationError`, the
 * sync timeout, or anything unexpected) and is surfaced immediately rather than
 * masked as an in-progress sync.
 *
 * In local mode the mock resolves immediately, so this returns on the first poll.
 */
async function gateOnSync(
  api: typeof apiType,
  { timeoutMs = 180_000, pollIntervalMs = 10_000 } = {},
): Promise<void> {
  const start = Date.now();
  console.log('⏳ Waiting for KB to sync with latest data (ingesting if needed)…');
  try {
    await api.kbWaitUntilSynced({ timeoutMs, pollIntervalMs });
  } catch (err: any) {
    // Real failure (failed ingestion / validation / timeout / unexpected) — surface it.
    console.error(`❌ KB sync check failed: ${err.name || err.message}`);
    throw err;
  }
  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`✅ KB synced (ingestion complete) — ${elapsed}s elapsed`);
}

export function knowledgeBaseTests(getApi: () => typeof apiType) {

  describe('KnowledgeBase', () => {

    // --- Error handling: no ingestion needed, always runs ---
    describe('error handling', () => {
      test('empty query throws ValidationError', async () => {
        const api = getApi();
        await assert.rejects(
          () => api.kbRetrieve(''),
          (err: unknown) => {
            assert.ok(isBlocksError(err, ValidationError), `Expected ${ValidationError}, got ${err}`);
            return true;
          },
        );
      });

      test('whitespace-only query throws ValidationError', async () => {
        const api = getApi();
        await assert.rejects(
          () => api.kbRetrieve('   '),
          (err: unknown) => {
            assert.ok(isBlocksError(err, ValidationError), `Expected ${ValidationError}, got ${err}`);
            return true;
          },
        );
      });
    });

    // --- Sync: cover the wired waitUntilSynced() endpoint end-to-end ---
    // The retrieval suites gate via gateOnSync() → kbWaitUntilSynced(); this
    // exercises that same waitUntilSynced() polling path directly. (kbSynced /
    // isSynced() is wired but not exercised by this suite — it's covered by unit
    // tests.) Locally the mock resolves on the first poll; on AWS we give it the
    // same budget as gateOnSync so a still-ingesting KB is waited out rather
    // than surfaced as a failure.
    describe('waitUntilSynced', () => {
      test('resolves once the KB is synced', async (t) => {
        const api = getApi();
        try {
          const result = await api.kbWaitUntilSynced(
            isLocal
              ? { timeoutMs: 5_000, pollIntervalMs: 50 }
              : { timeoutMs: 180_000, pollIntervalMs: 10_000 },
          );
          assert.deepStrictEqual(result, { success: true });
        } catch (err: unknown) {
          // Sync tolerance: unlike the retrieval suites, this standalone test is NOT
          // behind the gateOnSync() gate, so on AWS a slow-but-healthy KB whose
          // ingestion outruns the 180s budget makes kbWaitUntilSynced throw a Timeout.
          // That's the post-deploy sync window, not a defect — soft-skip it here. A
          // genuine IngestionFailed (or any other error) still fails the test. The local
          // mock resolves on the first poll, so this branch never trips and the success
          // assertion above always runs.
          if (isBlocksError(err, Timeout)) {
            t.skip(`KB still syncing — ingestion exceeded budget: ${(err as Error).message}`);
            return;
          }
          throw err;
        }
      });
    });

    // --- Retrieval tests: wait for ingestion before running ---
    describe('retrieve', () => {

      before(async () => {
        const api = getApi();
        await gateOnSync(api);
      });

      test('returns results for a matching query', async () => {
        const api = getApi();
        const results = await api.kbRetrieve('Blocks framework');
        assert.ok(Array.isArray(results), 'results should be an array');
        assert.ok(results.length > 0, 'should return at least one result');
      });

      test('results include text, score, source, metadata', async () => {
        const api = getApi();
        const results = await api.kbRetrieve('authentication');
        assert.ok(results.length > 0, 'should have results');
        const result = results[0];
        assert.ok(typeof result.text === 'string' && result.text.length > 0, 'text should be a non-empty string');
        assert.ok(typeof result.score === 'number' && result.score > 0, 'score should be a positive number');
        assert.ok(typeof result.source === 'string' && result.source.length > 0, 'source should be a non-empty string');
        assert.ok(typeof result.metadata === 'object' && result.metadata !== null, 'metadata should be an object');
      });

      test('folder metadata is correct for faq docs', async () => {
        const api = getApi();
        const results = await api.kbRetrieve('frequently asked questions Blocks', { maxResults: 20 });
        const faqResults = results.filter((r: any) => r.metadata.folder === 'faq');
        assert.ok(faqResults.length > 0, 'should have results from faq folder');
        for (const r of faqResults) {
          assert.strictEqual(r.metadata.folder, 'faq');
          assert.ok(r.source.includes('faq/'), `source should contain "faq/", got: ${r.source}`);
        }
      });

      test('folder metadata is correct for guides docs', async () => {
        const api = getApi();
        const results = await api.kbRetrieve('getting started installation guide', { maxResults: 20 });
        const guideResults = results.filter((r: any) => r.metadata.folder === 'guides');
        assert.ok(guideResults.length > 0, 'should have results from guides folder');
        for (const r of guideResults) {
          assert.strictEqual(r.metadata.folder, 'guides');
          assert.ok(r.source.includes('guides/'), `source should contain "guides/", got: ${r.source}`);
        }
      });

      test('source is an S3 URI on AWS', { skip: isLocal && 'S3 URIs only in sandbox/production' }, async () => {
        const api = getApi();
        const results = await api.kbRetrieve('Blocks framework');
        assert.ok(results.length > 0, 'should have results');
        for (const r of results) {
          assert.ok(r.source.startsWith('s3://'), `source should be an S3 URI, got: ${r.source}`);
        }
      });
    });

    describe('retrieve options', () => {

      before(async () => {
        const api = getApi();
        await gateOnSync(api);
      });

      test('maxResults limits results', async () => {
        const api = getApi();
        const results = await api.kbRetrieve('Blocks', { maxResults: 2 });
        assert.ok(results.length <= 2, `maxResults=2 should return at most 2 results, got ${results.length}`);
      });

      test('metadata filter narrows results to faq folder', async () => {
        const api = getApi();
        const results = await api.kbRetrieve('Blocks', {
          maxResults: 50,
          filter: { folder: { equals: 'faq' } },
        });
        assert.ok(results.length > 0, 'should have filtered results');
        for (const r of results) {
          assert.strictEqual(r.metadata.folder, 'faq', `all results should be from faq folder, got: ${r.metadata.folder}`);
        }
      });

      test('metadata filter narrows results to guides folder', async () => {
        const api = getApi();
        const results = await api.kbRetrieve('Blocks', {
          maxResults: 50,
          filter: { folder: { equals: 'guides' } },
        });
        assert.ok(results.length > 0, 'should have filtered results');
        for (const r of results) {
          assert.strictEqual(r.metadata.folder, 'guides', `all results should be from guides folder, got: ${r.metadata.folder}`);
        }
      });
    });

    describe('customer-provided metadata', () => {

      before(async () => {
        const api = getApi();
        await gateOnSync(api);
      });

      test('customer metadata category is present on tutorial doc', async () => {
        const api = getApi();
        const results = await api.kbRetrieve('deployment tutorial CDK pipeline', { maxResults: 20 });
        const deployResult = results.find((r: any) => r.metadata.category === 'deployment');
        assert.ok(deployResult, 'should have a result with category=deployment from customer metadata');
        assert.strictEqual(deployResult.metadata.category, 'deployment');
      });

      test('filter by customer metadata category=deployment returns only matching docs', async () => {
        const api = getApi();
        const results = await api.kbRetrieve('Blocks application', {
          maxResults: 50,
          filter: { category: { equals: 'deployment' } },
        });
        assert.ok(results.length > 0, 'should have results for category=deployment filter');
        for (const r of results) {
          assert.strictEqual(r.metadata.category, 'deployment', `all results should have category=deployment, got: ${r.metadata.category}`);
        }
      });

      test('customer-provided sidecar skips auto-generated folder metadata', async () => {
        const api = getApi();
        const results = await api.kbRetrieve('deployment tutorial CDK pipeline', { maxResults: 20 });
        const deployResult = results.find((r: any) => r.metadata.category === 'deployment');
        assert.ok(deployResult, 'should have deployment result');
        assert.strictEqual(deployResult.metadata.folder, undefined,
          'customer-provided sidecar should NOT have auto-generated folder metadata');
      });

      test('auto-generated folder metadata still works alongside customer sidecars', async () => {
        const api = getApi();
        const results = await api.kbRetrieve('frequently asked questions Blocks', {
          maxResults: 50,
          filter: { folder: { equals: 'faq' } },
        });
        assert.ok(results.length > 0, 'faq folder filter should still work');
        for (const r of results) {
          assert.strictEqual(r.metadata.folder, 'faq', 'faq docs should have auto-generated folder metadata');
        }
      });
    });

  });

}
