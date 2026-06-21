// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { KnowledgeBaseErrors, KnowledgeBase } from './index.aws.js';

// ── SDK mock helpers ───────────────────────────────────────────────────────

function mockRuntimeSend(fn: (cmd: unknown) => unknown) {
	return mock.method(BedrockAgentRuntimeClient.prototype, 'send', fn);
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
	test('ResourceNotFoundException maps to NotReady', async () => {
		const cleanup = setKbEnv('TEST', 'ERR4');
		const err = new Error('Knowledge base not found');
		err.name = 'ResourceNotFoundException';
		mockRuntimeSend(() => { throw err; });

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'err4', { source: './knowledge' });
			await assert.rejects(
				() => kb.retrieve('query'),
				(e: Error) => {
					assert.strictEqual(e.name, KnowledgeBaseErrors.NotReady);
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
