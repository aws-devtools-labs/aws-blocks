// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockAgentClient } from '@aws-sdk/client-bedrock-agent';
import { KnowledgeBaseErrors, KnowledgeBase } from './index.aws.js';

// ── SDK mock helpers ───────────────────────────────────────────────────────

function mockRuntimeSend(fn: (cmd: unknown) => unknown) {
	return mock.method(BedrockAgentRuntimeClient.prototype, 'send', fn);
}

// Control-plane client used by isReady()/waitUntilReady().
function mockAgentSend(fn: (cmd: { constructor: { name: string }; input: any }) => unknown) {
	return mock.method(BedrockAgentClient.prototype, 'send', fn as (cmd: unknown) => unknown);
}

afterEach(() => {
	try { mock.restoreAll(); } catch {}
});

function setKbEnv(scopeId: string, instanceId: string, kbId = 'kb-test-123') {
	const prefix = `BLOCKS_${scopeId}_${instanceId}`.toUpperCase().replace(/[^A-Z0-9]/g, '_');
	process.env[`${prefix}_KB_ID`] = kbId;
	return () => {
		delete process.env[`${prefix}_KB_ID`];
	};
}

// Sets KB_ID and (unless dataSourceId is null) DATA_SOURCE_ID, mirroring the
// two config values the CDK layer registers. Used by readiness tests.
function setReadyEnv(
	scopeId: string,
	instanceId: string,
	opts: { kbId?: string; dataSourceId?: string | null } = {},
) {
	const { kbId = 'kb-test-123', dataSourceId = 'ds-test-123' } = opts;
	const prefix = `BLOCKS_${scopeId}_${instanceId}`.toUpperCase().replace(/[^A-Z0-9]/g, '_');
	process.env[`${prefix}_KB_ID`] = kbId;
	if (dataSourceId !== null) process.env[`${prefix}_DATA_SOURCE_ID`] = dataSourceId;
	return () => {
		delete process.env[`${prefix}_KB_ID`];
		delete process.env[`${prefix}_DATA_SOURCE_ID`];
	};
}

// ── Constructor validation ─────────────────────────────────────────────────

describe('KnowledgeBase constructor validation', () => {
	test('constructor succeeds without env var but retrieve() throws NotReady', async () => {
		const origKb = process.env.BLOCKS_TEST_KB_KB_ID;
		delete process.env.BLOCKS_TEST_KB_KB_ID;

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'kb', { source: './knowledge' });
			assert.ok(kb, 'constructor should succeed without env var (lazy init)');

			await assert.rejects(
				() => kb.retrieve('test query'),
				(err: Error) => {
					assert.strictEqual(err.name, KnowledgeBaseErrors.NotReady);
					assert.ok(err.message.includes('BLOCKS_TEST_KB_KB_ID'));
					return true;
				},
			);
		} finally {
			if (origKb !== undefined) process.env.BLOCKS_TEST_KB_KB_ID = origKb;
		}
	});
});

// ── envKey — tested indirectly via constructor ─────────────────────────────

describe('envKey (indirect via constructor)', () => {
	test('sanitizes non-alphanumeric characters in scope id', () => {
		const cleanup = setKbEnv('MY_APP_KB', 'V2');
		try {
			const kb = new KnowledgeBase({ id: 'my-app/kb' }, 'v2', { source: './knowledge' });
			assert.ok(kb, 'constructor should succeed when env vars match sanitized key');
		} finally {
			cleanup();
		}
	});

	test('handles dots and spaces in scope id', () => {
		const cleanup = setKbEnv('MY_APP_NAME', 'DS');
		try {
			const kb = new KnowledgeBase({ id: 'my.app name' }, 'ds', { source: './knowledge' });
			assert.ok(kb, 'constructor should succeed with dots and spaces');
		} finally {
			cleanup();
		}
	});

	test('handles already uppercase input', () => {
		const cleanup = setKbEnv('PROD_KB', 'MAIN');
		try {
			const kb = new KnowledgeBase({ id: 'PROD-KB' }, 'main', { source: './knowledge' });
			assert.ok(kb, 'constructor should succeed with uppercase scope id');
		} finally {
			cleanup();
		}
	});

	test('handles compound scope IDs', () => {
		const cleanup = setKbEnv('MYAPP_DOCS', 'IDX');
		try {
			const kb = new KnowledgeBase({ id: 'myapp-docs' }, 'idx', { source: './knowledge' });
			assert.ok(kb, 'constructor should succeed with compound scope id');
		} finally {
			cleanup();
		}
	});
});

// ── Retrieve validation ────────────────────────────────────────────────────

describe('retrieve validation', () => {
	test('empty query throws ValidationError', async () => {
		const cleanup = setKbEnv('TEST', 'VAL');
		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'val', { source: './knowledge' });
			await assert.rejects(
				() => kb.retrieve(''),
				(err: Error) => {
					assert.strictEqual(err.name, KnowledgeBaseErrors.ValidationError);
					return true;
				},
			);
		} finally {
			cleanup();
		}
	});

	test('whitespace-only query throws ValidationError', async () => {
		const cleanup = setKbEnv('TEST', 'VAL2');
		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'val2', { source: './knowledge' });
			await assert.rejects(
				() => kb.retrieve('   '),
				(err: Error) => {
					assert.strictEqual(err.name, KnowledgeBaseErrors.ValidationError);
					return true;
				},
			);
		} finally {
			cleanup();
		}
	});

	test('non-string runtime query throws clean ValidationError', async () => {
		const cleanup = setKbEnv('TEST', 'VAL3');
		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'val3', { source: './knowledge' });
			for (const bad of [0, false, Number.NaN, null]) {
				await assert.rejects(
					() => kb.retrieve(bad as unknown as string),
					(err: Error) => {
						assert.strictEqual(err.name, KnowledgeBaseErrors.ValidationError);
						return true;
					},
				);
			}
		} finally {
			cleanup();
		}
	});
});

// ── retrieve() — mapResultItem tested indirectly via SDK mock ──────────────

describe('retrieve (SDK-mocked)', () => {
	test('maps text, score, source, metadata correctly', async () => {
		const cleanup = setKbEnv('TEST', 'R1');
		mockRuntimeSend(() => ({
			retrievalResults: [{
				content: { text: 'chunk content' },
				score: 0.85,
				location: { s3Location: { uri: 's3://bucket/doc.md' }, type: 'S3' },
				metadata: {
					folder: 'faq',
					'x-amz-bedrock-kb-chunk-id': 'internal',
					category: 'billing',
				},
			}],
		}));

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'r1', { source: './knowledge' });
			const results = await kb.retrieve('how to reset password');

			assert.strictEqual(results.length, 1);
			assert.strictEqual(results[0].text, 'chunk content');
			assert.strictEqual(results[0].score, 0.85);
			assert.strictEqual(results[0].source, 's3://bucket/doc.md');
			assert.strictEqual(results[0].metadata.folder, 'faq');
			assert.strictEqual(results[0].metadata.category, 'billing');
			assert.ok(!('x-amz-bedrock-kb-chunk-id' in results[0].metadata));
		} finally {
			cleanup();
		}
	});

	test('strips all x-amz-bedrock prefixed metadata keys', async () => {
		const cleanup = setKbEnv('TEST', 'R2');
		mockRuntimeSend(() => ({
			retrievalResults: [{
				content: { text: 'text' },
				score: 1.0,
				metadata: {
					'x-amz-bedrock-kb-chunk-id': 'abc123',
					'x-amz-bedrock-kb-source-uri': 's3://internal',
					'x-amz-bedrock-kb-data-source-id': 'ds-123',
					custom: 'value',
				},
			}],
		}));

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'r2', { source: './knowledge' });
			const results = await kb.retrieve('query');

			assert.deepStrictEqual(Object.keys(results[0].metadata), ['custom']);
			assert.strictEqual(results[0].metadata.custom, 'value');
		} finally {
			cleanup();
		}
	});

	test('handles missing content/score/location', async () => {
		const cleanup = setKbEnv('TEST', 'R3');
		mockRuntimeSend(() => ({
			retrievalResults: [{}],
		}));

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'r3', { source: './knowledge' });
			const results = await kb.retrieve('query');

			assert.strictEqual(results.length, 1);
			assert.strictEqual(results[0].text, '');
			assert.strictEqual(results[0].score, 0);
			assert.strictEqual(results[0].source, '');
			assert.deepStrictEqual(results[0].metadata, {});
		} finally {
			cleanup();
		}
	});

	test('handles missing content.text but present content object', async () => {
		const cleanup = setKbEnv('TEST', 'R4');
		mockRuntimeSend(() => ({
			retrievalResults: [{ content: {} }],
		}));

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'r4', { source: './knowledge' });
			const results = await kb.retrieve('query');
			assert.strictEqual(results[0].text, '');
		} finally {
			cleanup();
		}
	});

	test('handles location without s3Location', async () => {
		const cleanup = setKbEnv('TEST', 'R5');
		mockRuntimeSend(() => ({
			retrievalResults: [{ location: { type: 'S3' } }],
		}));

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'r5', { source: './knowledge' });
			const results = await kb.retrieve('query');
			assert.strictEqual(results[0].source, '');
		} finally {
			cleanup();
		}
	});

	test('stringifies non-string metadata values', async () => {
		const cleanup = setKbEnv('TEST', 'R6');
		mockRuntimeSend(() => ({
			retrievalResults: [{
				score: 1.0,
				metadata: {
					count: 42 as unknown as string,
					flag: true as unknown as string,
				},
			}],
		}));

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'r6', { source: './knowledge' });
			const results = await kb.retrieve('query');
			assert.strictEqual(results[0].metadata.count, '42');
			assert.strictEqual(results[0].metadata.flag, 'true');
		} finally {
			cleanup();
		}
	});

	test('excludes null/undefined metadata values', async () => {
		const cleanup = setKbEnv('TEST', 'R7');
		mockRuntimeSend(() => ({
			retrievalResults: [{
				score: 1.0,
				metadata: {
					present: 'yes',
					absent: null as unknown as string,
					missing: undefined as unknown as string,
				},
			}],
		}));

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'r7', { source: './knowledge' });
			const results = await kb.retrieve('query');
			assert.strictEqual(results[0].metadata.present, 'yes');
			assert.ok(!('absent' in results[0].metadata));
			assert.ok(!('missing' in results[0].metadata));
		} finally {
			cleanup();
		}
	});

	test('clamps maxResults to 1–100 range', async () => {
		const cleanup = setKbEnv('TEST', 'R9');
		let capturedNumberOfResults: number | undefined;
		mockRuntimeSend((cmd: any) => {
			capturedNumberOfResults = cmd.input?.retrievalConfiguration
				?.vectorSearchConfiguration?.numberOfResults;
			return { retrievalResults: [] };
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'r9', { source: './knowledge' });

			await kb.retrieve('query', { maxResults: 0 });
			assert.strictEqual(capturedNumberOfResults, 1, 'maxResults=0 should be clamped to 1');

			await kb.retrieve('query', { maxResults: 200 });
			assert.strictEqual(capturedNumberOfResults, 100, 'maxResults=200 should be clamped to 100');

			await kb.retrieve('query', { maxResults: 50 });
			assert.strictEqual(capturedNumberOfResults, 50, 'maxResults=50 should pass through');
		} finally {
			cleanup();
		}
	});

	test('handles empty retrievalResults', async () => {
		const cleanup = setKbEnv('TEST', 'R10');
		mockRuntimeSend(() => ({ retrievalResults: [] }));

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'r10', { source: './knowledge' });
			const results = await kb.retrieve('query');
			assert.deepStrictEqual(results, []);
		} finally {
			cleanup();
		}
	});

	test('handles undefined retrievalResults', async () => {
		const cleanup = setKbEnv('TEST', 'R11');
		mockRuntimeSend(() => ({}));

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'r11', { source: './knowledge' });
			const results = await kb.retrieve('query');
			assert.deepStrictEqual(results, []);
		} finally {
			cleanup();
		}
	});
});

// ── Error classification — ValidationException ─────────────────────────────
//
// SDK exceptions are mapped to Blocks error constants based on the actual
// cause, not just the exception name. ValidationException is especially
// ambiguous — Bedrock throws it for invalid filters, over-long queries, and
// malformed requests alike — so a content/query error must never be reported
// to the caller as a filter problem.

describe('error classification — ValidationException', () => {
	test('filter-related ValidationException maps to InvalidFilter', async () => {
		const cleanup = setKbEnv('TEST', 'ERR1');
		const filterErr = new Error("failed to create query: Field 'category.keyword' not found. Rewrite first");
		filterErr.name = 'ValidationException';
		mockRuntimeSend(() => { throw filterErr; });

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'err1', { source: './knowledge' });
			await assert.rejects(
				() => kb.retrieve('test', { filter: { category: { equals: 'x' } } }),
				(err: Error) => {
					assert.strictEqual(
						err.name,
						KnowledgeBaseErrors.InvalidFilter,
						'Filter-related ValidationException should map to InvalidFilter',
					);
					return true;
				},
			);
		} finally {
			cleanup();
		}
	});

	test('query-length ValidationException does NOT map to InvalidFilter', async () => {
		const cleanup = setKbEnv('TEST', 'ERR2');
		const queryErr = new Error(
			"1 validation error detected: Value at 'retrievalQuery.text' failed to satisfy " +
				'constraint: Member must have length less than or equal to 1000',
		);
		queryErr.name = 'ValidationException';
		mockRuntimeSend(() => { throw queryErr; });

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'err2', { source: './knowledge' });
			await assert.rejects(
				() => kb.retrieve('a'.repeat(1001)),
				(err: Error) => {
					assert.notStrictEqual(
						err.name,
						KnowledgeBaseErrors.InvalidFilter,
						'Query-length ValidationException must NOT map to InvalidFilter',
					);
					assert.ok(
						err.name === KnowledgeBaseErrors.ValidationError ||
							err.name === KnowledgeBaseErrors.RetrievalFailed,
						`Expected ValidationError or RetrievalFailed, got: ${err.name}`,
					);
					return true;
				},
			);
		} finally {
			cleanup();
		}
	});

	test('original error message is preserved in the mapped error for debugging', async () => {
		const cleanup = setKbEnv('TEST', 'ERR3');
		const originalMsg = 'Specific validation error details from Bedrock service';
		const err = new Error(originalMsg);
		err.name = 'ValidationException';
		mockRuntimeSend(() => { throw err; });

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'err3', { source: './knowledge' });
			await assert.rejects(
				() => kb.retrieve('test', { filter: { x: { equals: 'y' } } }),
				(e: Error) => {
					assert.ok(
						e.message.includes(originalMsg),
						'Mapped error should preserve original message for debugging',
					);
					return true;
				},
			);
		} finally {
			cleanup();
		}
	});
});

// ── Error classification — other SDK exceptions ────────────────────────────

describe('error classification — other SDK exceptions', () => {
	test('ResourceNotFoundException maps to NotReady (actionable hint + original SDK message)', async () => {
		const cleanup = setKbEnv('TEST', 'ERR4');
		const err = new Error('No knowledge base with ID kb-xyz exists');
		err.name = 'ResourceNotFoundException';
		mockRuntimeSend(() => { throw err; });

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'err4', { source: './knowledge' });
			await assert.rejects(
				() => kb.retrieve('query'),
				(e: Error) => {
					assert.strictEqual(e.name, KnowledgeBaseErrors.NotReady);
					assert.ok(
						e.message.includes('cdk deploy'),
						'NotReady message should keep the actionable deploy hint',
					);
					assert.ok(
						e.message.includes('No knowledge base with ID kb-xyz exists'),
						'NotReady message should append the original SDK message',
					);
					return true;
				},
			);
		} finally {
			cleanup();
		}
	});

	test('AccessDeniedException maps to RetrievalFailed and preserves message + original error as a non-enumerable cause', async () => {
		const cleanup = setKbEnv('TEST', 'ERR5');
		// Mimic the SDK error shape: $metadata carries a requestId that must never
		// leak through JSON.stringify of the mapped (caller-facing) error.
		const err = Object.assign(new Error('User is not authorized to perform bedrock:Retrieve'), {
			$metadata: { requestId: 'req-abc-123' },
		});
		err.name = 'AccessDeniedException';
		mockRuntimeSend(() => { throw err; });

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'err5', { source: './knowledge' });
			await assert.rejects(
				() => kb.retrieve('query'),
				(e: Error) => {
					assert.strictEqual(e.name, KnowledgeBaseErrors.RetrievalFailed);
					assert.ok(
						e.message.includes('not authorized'),
						'Error message should preserve the original SDK message',
					);
					assert.strictEqual(
						e.cause,
						err,
						'Mapped error should attach the original SDK error as `cause`',
					);
					// `cause` must be NON-ENUMERABLE so JSON.stringify of the mapped
					// error does not serialize the SDK error or leak its $metadata.
					const serialized = JSON.stringify(e);
					assert.ok(
						!serialized.includes('cause'),
						'`cause` must be non-enumerable (absent from JSON.stringify output)',
					);
					assert.ok(
						!serialized.includes('req-abc-123'),
						'SDK error $metadata/requestId must not leak through JSON.stringify',
					);
					return true;
				},
			);
		} finally {
			cleanup();
		}
	});
});

// ── Readiness — isReady() ──────────────────────────────────────────────────
//
// Ingestion runs asynchronously after deploy, so isReady() inspects the data
// source's most recent ingestion job: COMPLETE → ready, FAILED → throws,
// anything else (or no jobs / no data source) → not-ready (or ready when there
// is nothing to track).

describe('isReady', () => {
	test('returns true when the latest ingestion job is COMPLETE', async () => {
		const cleanup = setReadyEnv('TEST', 'RDY1');
		mockAgentSend((cmd) => {
			assert.strictEqual(cmd.constructor.name, 'ListIngestionJobsCommand');
			return { ingestionJobSummaries: [{ ingestionJobId: 'job-1', status: 'COMPLETE' }] };
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'rdy1', { source: './knowledge' });
			assert.strictEqual(await kb.isReady(), true);
		} finally {
			cleanup();
		}
	});

	test('returns false when the latest ingestion job is IN_PROGRESS', async () => {
		const cleanup = setReadyEnv('TEST', 'RDY2');
		mockAgentSend(() => ({ ingestionJobSummaries: [{ ingestionJobId: 'job-1', status: 'IN_PROGRESS' }] }));

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'rdy2', { source: './knowledge' });
			assert.strictEqual(await kb.isReady(), false);
		} finally {
			cleanup();
		}
	});

	test('returns false when no ingestion jobs exist yet (empty list)', async () => {
		const cleanup = setReadyEnv('TEST', 'RDY3');
		mockAgentSend(() => ({ ingestionJobSummaries: [] }));

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'rdy3', { source: './knowledge' });
			assert.strictEqual(await kb.isReady(), false);
		} finally {
			cleanup();
		}
	});

	test('returns false when ingestionJobSummaries is undefined', async () => {
		const cleanup = setReadyEnv('TEST', 'RDY3B');
		mockAgentSend(() => ({}));

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'rdy3b', { source: './knowledge' });
			assert.strictEqual(await kb.isReady(), false);
		} finally {
			cleanup();
		}
	});

	test('returns true (without calling the control plane) when no data source id is configured', async () => {
		// A deployment that predates the readiness API: KB_ID present, but no
		// DATA_SOURCE_ID was injected, so there is no ingestion job to track. (The
		// CDK layer now always registers a DATA_SOURCE_ID for both folder and
		// imported s3:// sources — see DESIGN.md, the "Source coverage (folder and
		// imported s3://)" note — so this is purely the pre-feature case, not a
		// source-type distinction.)
		const cleanup = setReadyEnv('TEST', 'RDY4', { dataSourceId: null });
		let sendCalled = false;
		mockAgentSend(() => {
			sendCalled = true;
			return { ingestionJobSummaries: [] };
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'rdy4', { source: './knowledge' });
			assert.strictEqual(await kb.isReady(), true);
			assert.strictEqual(sendCalled, false, 'should not query the control plane when there is no data source to track');
		} finally {
			cleanup();
		}
	});

	test('throws NotReady when KB_ID env var is not set', async () => {
		const prefix = 'BLOCKS_TEST_RDY5';
		const orig = process.env[`${prefix}_KB_ID`];
		delete process.env[`${prefix}_KB_ID`];

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'rdy5', { source: './knowledge' });
			await assert.rejects(
				() => kb.isReady(),
				(err: Error) => {
					assert.strictEqual(err.name, KnowledgeBaseErrors.NotReady);
					return true;
				},
			);
		} finally {
			if (orig !== undefined) process.env[`${prefix}_KB_ID`] = orig;
		}
	});

	test('throws IngestionFailed (with failureReasons) when the latest job FAILED', async () => {
		const cleanup = setReadyEnv('TEST', 'RDY6');
		mockAgentSend((cmd) => {
			if (cmd.constructor.name === 'ListIngestionJobsCommand') {
				return { ingestionJobSummaries: [{ ingestionJobId: 'job-x', status: 'FAILED' }] };
			}
			// GetIngestionJobCommand → failure detail
			return { ingestionJob: { status: 'FAILED', failureReasons: ['boom one', 'boom two'] } };
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'rdy6', { source: './knowledge' });
			await assert.rejects(
				() => kb.isReady(),
				(err: Error) => {
					assert.strictEqual(err.name, KnowledgeBaseErrors.IngestionFailed);
					assert.ok(err.message.includes('boom one'), 'message should include failure reasons');
					assert.ok(err.message.includes('boom two'));
					return true;
				},
			);
		} finally {
			cleanup();
		}
	});

	test('queries ListIngestionJobs with the configured ids, sorted by STARTED_AT desc, maxResults 1', async () => {
		const cleanup = setReadyEnv('TEST', 'RDY7', { kbId: 'kb-aaa', dataSourceId: 'ds-bbb' });
		let captured: any;
		mockAgentSend((cmd) => {
			captured = cmd.input;
			return { ingestionJobSummaries: [{ ingestionJobId: 'j', status: 'COMPLETE' }] };
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'rdy7', { source: './knowledge' });
			await kb.isReady();
			assert.strictEqual(captured.knowledgeBaseId, 'kb-aaa');
			assert.strictEqual(captured.dataSourceId, 'ds-bbb');
			assert.strictEqual(captured.maxResults, 1);
			assert.strictEqual(captured.sortBy.attribute, 'STARTED_AT');
			assert.strictEqual(captured.sortBy.order, 'DESCENDING');
		} finally {
			cleanup();
		}
	});

	test('maps control-plane ResourceNotFoundException to NotReady', async () => {
		const cleanup = setReadyEnv('TEST', 'RDY8');
		const err = new Error('No knowledge base with ID kb-test-123 exists');
		err.name = 'ResourceNotFoundException';
		mockAgentSend(() => { throw err; });

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'rdy8', { source: './knowledge' });
			await assert.rejects(
				() => kb.isReady(),
				(e: Error) => {
					assert.strictEqual(e.name, KnowledgeBaseErrors.NotReady);
					return true;
				},
			);
		} finally {
			cleanup();
		}
	});
});

// ── Readiness — waitUntilReady() ───────────────────────────────────────────

describe('waitUntilReady', () => {
	test('resolves immediately when ingestion is already COMPLETE', async () => {
		const cleanup = setReadyEnv('TEST', 'WUR1');
		mockAgentSend(() => ({ ingestionJobSummaries: [{ ingestionJobId: 'j', status: 'COMPLETE' }] }));

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'wur1', { source: './knowledge' });
			await kb.waitUntilReady({ timeoutMs: 1000, pollIntervalMs: 10 });
		} finally {
			cleanup();
		}
	});

	test('polls until the ingestion job becomes COMPLETE', async () => {
		const cleanup = setReadyEnv('TEST', 'WUR2');
		let calls = 0;
		mockAgentSend(() => {
			calls += 1;
			const status = calls < 3 ? 'IN_PROGRESS' : 'COMPLETE';
			return { ingestionJobSummaries: [{ ingestionJobId: 'j', status }] };
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'wur2', { source: './knowledge' });
			await kb.waitUntilReady({ timeoutMs: 5000, pollIntervalMs: 5 });
			assert.ok(calls >= 3, `expected at least 3 polls before COMPLETE, got ${calls}`);
		} finally {
			cleanup();
		}
	});

	test('throws IngestionFailed (with failureReasons) when ingestion FAILED', async () => {
		const cleanup = setReadyEnv('TEST', 'WUR3');
		mockAgentSend((cmd) => {
			if (cmd.constructor.name === 'ListIngestionJobsCommand') {
				return { ingestionJobSummaries: [{ ingestionJobId: 'job-fail', status: 'FAILED' }] };
			}
			return { ingestionJob: { status: 'FAILED', failureReasons: ['S3 access denied'] } };
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'wur3', { source: './knowledge' });
			await assert.rejects(
				() => kb.waitUntilReady({ timeoutMs: 1000, pollIntervalMs: 10 }),
				(err: Error) => {
					assert.strictEqual(err.name, KnowledgeBaseErrors.IngestionFailed);
					assert.ok(err.message.includes('S3 access denied'), 'should surface failure reasons');
					return true;
				},
			);
		} finally {
			cleanup();
		}
	});

	test('throws Timeout when the job never completes within the budget', async () => {
		const cleanup = setReadyEnv('TEST', 'WUR4');
		mockAgentSend(() => ({ ingestionJobSummaries: [{ ingestionJobId: 'j', status: 'IN_PROGRESS' }] }));

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'wur4', { source: './knowledge' });
			await assert.rejects(
				() => kb.waitUntilReady({ timeoutMs: 30, pollIntervalMs: 5 }),
				(err: Error) => {
					assert.strictEqual(err.name, KnowledgeBaseErrors.Timeout);
					assert.ok(err.message.includes('30ms'), 'timeout message should include the budget');
					// Every poll was a clean IN_PROGRESS (no transient errors), so the
					// message stays the plain form — no transient detail appended.
					assert.ok(
						!err.message.includes('last transient error'),
						'a clean (non-transient) timeout must not claim a transient error',
					);
					return true;
				},
			);
		} finally {
			cleanup();
		}
	});

	test('Timeout message surfaces the last transient error when the budget runs out mid-streak', async () => {
		const cleanup = setReadyEnv('TEST', 'WUR16');
		// Every poll throws a transient (throttling → RetrievalFailed) error, but the
		// tolerance is high enough that the deadline — not the transient budget — ends
		// the wait. The Timeout message must then surface the last transient error so a
		// caller can't mistake it for a healthy KB that merely never finished ingesting.
		mockAgentSend(() => {
			const e = new Error('Rate exceeded');
			e.name = 'ThrottlingException'; // → RetrievalFailed (transient) on every poll
			throw e;
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'wur16', { source: './knowledge' });
			await assert.rejects(
				() => kb.waitUntilReady({ timeoutMs: 30, pollIntervalMs: 5, maxConsecutiveTransientErrors: 1000 }),
				(err: Error) => {
					assert.strictEqual(err.name, KnowledgeBaseErrors.Timeout);
					assert.ok(err.message.includes('30ms'), 'timeout message should include the budget');
					assert.ok(
						err.message.includes('last transient error'),
						'timeout message should flag that the final polls were failing transiently',
					);
					assert.ok(
						err.message.includes('Rate exceeded'),
						'timeout message should include the underlying transient detail',
					);
					return true;
				},
			);
		} finally {
			cleanup();
		}
	});

	test('resolves immediately when no data source id is configured', async () => {
		// Pre-readiness-API deployment: no DATA_SOURCE_ID injected, so there is
		// nothing to poll. (Not a source-type distinction — the CDK layer registers
		// DATA_SOURCE_ID for folder and imported s3:// sources alike; see DESIGN.md,
		// the "Source coverage (folder and imported s3://)" note.)
		const cleanup = setReadyEnv('TEST', 'WUR5', { dataSourceId: null });
		let sendCalled = false;
		mockAgentSend(() => {
			sendCalled = true;
			return { ingestionJobSummaries: [] };
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'wur5', { source: './knowledge' });
			await kb.waitUntilReady({ timeoutMs: 30, pollIntervalMs: 5 });
			assert.strictEqual(sendCalled, false, 'should not poll the control plane when there is nothing to track');
		} finally {
			cleanup();
		}
	});

	test('tolerates a transient control-plane error, then resolves once COMPLETE', async () => {
		const cleanup = setReadyEnv('TEST', 'WUR6');
		let calls = 0;
		mockAgentSend(() => {
			calls += 1;
			if (calls === 1) {
				// Unrecognized SDK error → mapSdkError classifies it as RetrievalFailed (transient).
				const e = new Error('Rate exceeded');
				e.name = 'ThrottlingException';
				throw e;
			}
			return { ingestionJobSummaries: [{ ingestionJobId: 'j', status: 'COMPLETE' }] };
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'wur6', { source: './knowledge' });
			await kb.waitUntilReady({ timeoutMs: 5000, pollIntervalMs: 1 });
			assert.ok(calls >= 2, `expected a retry after the transient blip, got ${calls} call(s)`);
		} finally {
			cleanup();
		}
	});

	test('throws once consecutive transient errors exceed the tolerance', async () => {
		const cleanup = setReadyEnv('TEST', 'WUR7');
		let calls = 0;
		mockAgentSend(() => {
			calls += 1;
			const e = new Error('Rate exceeded');
			e.name = 'ThrottlingException'; // → RetrievalFailed (transient) on every poll
			throw e;
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'wur7', { source: './knowledge' });
			await assert.rejects(
				() => kb.waitUntilReady({ timeoutMs: 5000, pollIntervalMs: 1, maxConsecutiveTransientErrors: 2 }),
				(err: Error) => {
					assert.strictEqual(err.name, KnowledgeBaseErrors.RetrievalFailed);
					return true;
				},
			);
			// tolerance 2 → polls 1 & 2 absorbed, poll 3 exceeds the limit and rethrows.
			assert.strictEqual(calls, 3, `expected 3 polls (2 tolerated + 1 over the limit), got ${calls}`);
		} finally {
			cleanup();
		}
	});

	test('short-circuits immediately on IngestionFailed (never retried as transient)', async () => {
		const cleanup = setReadyEnv('TEST', 'WUR8');
		let listCalls = 0;
		mockAgentSend((cmd) => {
			if (cmd.constructor.name === 'ListIngestionJobsCommand') {
				listCalls += 1;
				return { ingestionJobSummaries: [{ ingestionJobId: 'job-fail', status: 'FAILED' }] };
			}
			return { ingestionJob: { status: 'FAILED', failureReasons: ['boom'] } };
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'wur8', { source: './knowledge' });
			await assert.rejects(
				() => kb.waitUntilReady({ timeoutMs: 5000, pollIntervalMs: 1, maxConsecutiveTransientErrors: 5 }),
				(err: Error) => {
					assert.strictEqual(err.name, KnowledgeBaseErrors.IngestionFailed);
					return true;
				},
			);
			assert.strictEqual(listCalls, 1, 'a FAILED job is terminal — it must short-circuit, not poll again');
		} finally {
			cleanup();
		}
	});

	test('short-circuits immediately on NotReady (unset KB_ID is not retried forever)', async () => {
		const prefix = 'BLOCKS_TEST_WUR9';
		const orig = process.env[`${prefix}_KB_ID`];
		delete process.env[`${prefix}_KB_ID`];
		let sendCalled = false;
		mockAgentSend(() => {
			sendCalled = true;
			return { ingestionJobSummaries: [] };
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'wur9', { source: './knowledge' });
			await assert.rejects(
				() => kb.waitUntilReady({ timeoutMs: 5000, pollIntervalMs: 1, maxConsecutiveTransientErrors: 5 }),
				(err: Error) => {
					assert.strictEqual(err.name, KnowledgeBaseErrors.NotReady);
					return true;
				},
			);
			assert.strictEqual(sendCalled, false, 'a missing-KB config error fails before any poll and must not be retried');
		} finally {
			if (orig !== undefined) process.env[`${prefix}_KB_ID`] = orig;
		}
	});

	test('resets the transient-error counter after a clean poll', async () => {
		const cleanup = setReadyEnv('TEST', 'WUR10');
		// transient → clean (IN_PROGRESS) → transient → COMPLETE. With tolerance 1 this
		// only succeeds if the counter resets after the clean poll — otherwise the second
		// transient error would be the 2nd consecutive failure and exceed the limit.
		const seq = ['throw', 'IN_PROGRESS', 'throw', 'COMPLETE'];
		let i = 0;
		mockAgentSend(() => {
			const step = seq[i++] ?? 'COMPLETE';
			if (step === 'throw') {
				const e = new Error('Rate exceeded');
				e.name = 'ThrottlingException';
				throw e;
			}
			return { ingestionJobSummaries: [{ ingestionJobId: 'j', status: step }] };
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'wur10', { source: './knowledge' });
			await kb.waitUntilReady({ timeoutMs: 5000, pollIntervalMs: 1, maxConsecutiveTransientErrors: 1 });
			assert.strictEqual(i, 4, 'should consume the full transient/clean/transient/complete sequence');
		} finally {
			cleanup();
		}
	});

	// Cause-based transient classification: a control-plane ResourceNotFoundException
	// (the KB/data source not yet visible in the post-deploy window) maps to NotReady
	// WITH a `cause`, and is tolerated as transient — whereas an unset-KB_ID NotReady
	// (thrown directly by ensureKbId, no `cause`) stays terminal.

	test('tolerates a transient control-plane ResourceNotFoundException (KB not yet visible), then resolves once COMPLETE', async () => {
		const cleanup = setReadyEnv('TEST', 'WUR11');
		let calls = 0;
		mockAgentSend(() => {
			calls += 1;
			if (calls === 1) {
				// Post-deploy window: the freshly-created KB/data source has not
				// propagated yet, so the control plane 404s. mapSdkError maps this to
				// NotReady with cause.name === 'ResourceNotFoundException' → transient.
				const e = new Error('No knowledge base with ID kb-test-123 exists');
				e.name = 'ResourceNotFoundException';
				throw e;
			}
			return { ingestionJobSummaries: [{ ingestionJobId: 'j', status: 'COMPLETE' }] };
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'wur11', { source: './knowledge' });
			await kb.waitUntilReady({ timeoutMs: 5000, pollIntervalMs: 1 });
			assert.ok(calls >= 2, `expected a retry after the not-yet-visible blip, got ${calls} call(s)`);
		} finally {
			cleanup();
		}
	});

	test('throws once consecutive control-plane ResourceNotFound errors exceed the tolerance', async () => {
		const cleanup = setReadyEnv('TEST', 'WUR12');
		let calls = 0;
		mockAgentSend(() => {
			calls += 1;
			const e = new Error('No knowledge base with ID kb-test-123 exists');
			e.name = 'ResourceNotFoundException'; // → NotReady (transient, carries cause) on every poll
			throw e;
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'wur12', { source: './knowledge' });
			await assert.rejects(
				() => kb.waitUntilReady({ timeoutMs: 5000, pollIntervalMs: 1, maxConsecutiveTransientErrors: 2 }),
				(err: Error) => {
					assert.strictEqual(err.name, KnowledgeBaseErrors.NotReady);
					assert.strictEqual(
						(err.cause as Error | undefined)?.name,
						'ResourceNotFoundException',
						'the rethrown NotReady should still carry the originating SDK error as cause',
					);
					return true;
				},
			);
			// tolerance 2 → polls 1 & 2 absorbed, poll 3 exceeds the limit and rethrows.
			assert.strictEqual(calls, 3, `expected 3 polls (2 tolerated + 1 over the limit), got ${calls}`);
		} finally {
			cleanup();
		}
	});

	test('does NOT retry an unset-KB_ID NotReady (config error has no cause → terminal)', async () => {
		const prefix = 'BLOCKS_TEST_WUR13';
		const orig = process.env[`${prefix}_KB_ID`];
		delete process.env[`${prefix}_KB_ID`];
		let sendCalled = false;
		mockAgentSend(() => {
			sendCalled = true;
			return { ingestionJobSummaries: [] };
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'wur13', { source: './knowledge' });
			await assert.rejects(
				() => kb.waitUntilReady({ timeoutMs: 5000, pollIntervalMs: 1, maxConsecutiveTransientErrors: 5 }),
				(err: Error) => {
					assert.strictEqual(err.name, KnowledgeBaseErrors.NotReady);
					// The cause-based classification hinges on this: ensureKbId() throws
					// NotReady directly, so there is no `cause` (unlike a not-yet-visible
					// ResourceNotFoundException) — which keeps the config error terminal.
					assert.strictEqual(err.cause, undefined, 'a config NotReady must carry no cause');
					return true;
				},
			);
			assert.strictEqual(sendCalled, false, 'a missing-KB config error fails before any poll and must not be retried');
		} finally {
			if (orig !== undefined) process.env[`${prefix}_KB_ID`] = orig;
		}
	});

	// Cancellation via AbortSignal — checked before each poll and during the inter-poll sleep.

	test('rejects immediately when the signal is already aborted (no polling)', async () => {
		const cleanup = setReadyEnv('TEST', 'WUR14');
		let sendCalled = false;
		mockAgentSend(() => {
			sendCalled = true;
			return { ingestionJobSummaries: [{ ingestionJobId: 'j', status: 'IN_PROGRESS' }] };
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'wur14', { source: './knowledge' });
			await assert.rejects(
				() => kb.waitUntilReady({ timeoutMs: 5000, pollIntervalMs: 5, signal: AbortSignal.abort() }),
				(err: Error) => {
					assert.strictEqual(err.name, 'AbortError', 'default abort reason is a DOMException named AbortError');
					return true;
				},
			);
			assert.strictEqual(sendCalled, false, 'an already-aborted signal must reject before any poll');
		} finally {
			cleanup();
		}
	});

	test('aborts during the inter-poll delay and rejects with the supplied abort reason', async () => {
		const cleanup = setReadyEnv('TEST', 'WUR15');
		const controller = new AbortController();
		let calls = 0;
		mockAgentSend(() => {
			calls += 1;
			// Always "still warming" so the wait reaches the inter-poll sleep, where
			// the abort fired below interrupts it.
			return { ingestionJobSummaries: [{ ingestionJobId: 'j', status: 'IN_PROGRESS' }] };
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'wur15', { source: './knowledge' });
			const reason = new Error('caller cancelled');
			setTimeout(() => controller.abort(reason), 20).unref?.();
			await assert.rejects(
				() => kb.waitUntilReady({ timeoutMs: 60_000, pollIntervalMs: 50, signal: controller.signal }),
				(err: Error) => {
					assert.strictEqual(err, reason, 'should reject with the exact reason passed to abort()');
					return true;
				},
			);
			assert.ok(calls >= 1, 'should have polled at least once before being aborted');
		} finally {
			cleanup();
		}
	});
});
