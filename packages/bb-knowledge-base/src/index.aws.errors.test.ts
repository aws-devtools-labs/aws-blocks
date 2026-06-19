// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for AWS runtime error classification.
 *
 * Verifies that SDK exceptions are mapped to the correct Blocks error constants
 * based on the actual cause — not just the exception name. In particular,
 * ValidationException can be thrown for multiple reasons (invalid filter,
 * query too long, malformed request) and must be classified accordingly.
 */

import { test, afterEach, describe, mock } from 'node:test';
import assert from 'node:assert';
import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { KnowledgeBase, KnowledgeBaseErrors } from './index.aws.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function mockSend(fn: (cmd: unknown) => unknown) {
	return mock.method(BedrockAgentRuntimeClient.prototype, 'send', fn);
}

afterEach(() => {
	try {
		mock.restoreAll();
	} catch {}
});

function setKbEnv(scopeId: string, instanceId: string, kbId = 'kb-test-123') {
	const prefix = `BLOCKS_${scopeId}_${instanceId}`.toUpperCase().replace(/[^A-Z0-9]/g, '_');
	process.env[`${prefix}_KB_ID`] = kbId;
	return () => {
		delete process.env[`${prefix}_KB_ID`];
	};
}

// ════════════════════════════════════════════════════════════════════════════
// ValidationException classification
// ════════════════════════════════════════════════════════════════════════════

describe('ValidationException classification', () => {
	test('filter-related ValidationException maps to InvalidFilter', async () => {
		const cleanup = setKbEnv('TEST', 'ERR1');
		const filterErr = new Error("failed to create query: Field 'category.keyword' not found. Rewrite first");
		filterErr.name = 'ValidationException';
		mockSend(() => {
			throw filterErr;
		});

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

	test('query-length ValidationException should NOT map to InvalidFilter', async () => {
		const cleanup = setKbEnv('TEST', 'ERR2');
		const queryErr = new Error(
			"1 validation error detected: Value at 'retrievalQuery.text' failed to satisfy " +
				'constraint: Member must have length less than or equal to 1000',
		);
		queryErr.name = 'ValidationException';
		mockSend(() => {
			throw queryErr;
		});

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
					// Should be ValidationError (query issue) or RetrievalFailed (generic)
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

	test('malformed-request ValidationException should NOT map to InvalidFilter', async () => {
		const cleanup = setKbEnv('TEST', 'ERR3');
		const malformedErr = new Error('Invalid request body');
		malformedErr.name = 'ValidationException';
		mockSend(() => {
			throw malformedErr;
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'err3', { source: './knowledge' });
			await assert.rejects(
				() => kb.retrieve('normal query'),
				(err: Error) => {
					assert.notStrictEqual(
						err.name,
						KnowledgeBaseErrors.InvalidFilter,
						'Malformed-request ValidationException must NOT map to InvalidFilter',
					);
					return true;
				},
			);
		} finally {
			cleanup();
		}
	});

	test('numberOfResults ValidationException should NOT map to InvalidFilter', async () => {
		const cleanup = setKbEnv('TEST', 'ERR4');
		const numErr = new Error(
			'1 validation error detected: Value at ' +
				"'retrievalConfiguration.vectorSearchConfiguration.numberOfResults' " +
				'failed to satisfy constraint',
		);
		numErr.name = 'ValidationException';
		mockSend(() => {
			throw numErr;
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'err4', { source: './knowledge' });
			await assert.rejects(
				() => kb.retrieve('test query'),
				(err: Error) => {
					assert.notStrictEqual(
						err.name,
						KnowledgeBaseErrors.InvalidFilter,
						'numberOfResults ValidationException must NOT map to InvalidFilter',
					);
					return true;
				},
			);
		} finally {
			cleanup();
		}
	});

	test('error message is preserved in mapped error for debugging', async () => {
		const cleanup = setKbEnv('TEST', 'ERR5');
		const originalMsg = 'Specific validation error details from Bedrock service';
		const err = new Error(originalMsg);
		err.name = 'ValidationException';
		mockSend(() => {
			throw err;
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'err5', { source: './knowledge' });
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

// ════════════════════════════════════════════════════════════════════════════
// Other SDK exception mappings (control tests)
// ════════════════════════════════════════════════════════════════════════════

describe('other SDK exception mappings', () => {
	test('ResourceNotFoundException maps to NotReady', async () => {
		const cleanup = setKbEnv('TEST', 'ERR6');
		const err = new Error('Knowledge base not found');
		err.name = 'ResourceNotFoundException';
		mockSend(() => {
			throw err;
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'err6', { source: './knowledge' });
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

	test('AccessDeniedException maps to RetrievalFailed', async () => {
		const cleanup = setKbEnv('TEST', 'ERR7');
		const err = new Error('User is not authorized to perform bedrock:Retrieve');
		err.name = 'AccessDeniedException';
		mockSend(() => {
			throw err;
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'err7', { source: './knowledge' });
			await assert.rejects(
				() => kb.retrieve('query'),
				(e: Error) => {
					assert.strictEqual(e.name, KnowledgeBaseErrors.RetrievalFailed);
					assert.ok(
						e.message.includes('not authorized'),
						'Error message should preserve the original SDK message',
					);
					return true;
				},
			);
		} finally {
			cleanup();
		}
	});

	test('ThrottlingException maps to RetrievalFailed', async () => {
		const cleanup = setKbEnv('TEST', 'ERR8');
		const err = new Error('Rate exceeded');
		err.name = 'ThrottlingException';
		mockSend(() => {
			throw err;
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'err8', { source: './knowledge' });
			await assert.rejects(
				() => kb.retrieve('query'),
				(e: Error) => {
					assert.strictEqual(e.name, KnowledgeBaseErrors.RetrievalFailed);
					return true;
				},
			);
		} finally {
			cleanup();
		}
	});

	test('InternalServerException maps to RetrievalFailed', async () => {
		const cleanup = setKbEnv('TEST', 'ERR9');
		const err = new Error('Internal server error');
		err.name = 'InternalServerException';
		mockSend(() => {
			throw err;
		});

		try {
			const kb = new KnowledgeBase({ id: 'test' }, 'err9', { source: './knowledge' });
			await assert.rejects(
				() => kb.retrieve('query'),
				(e: Error) => {
					assert.strictEqual(e.name, KnowledgeBaseErrors.RetrievalFailed);
					return true;
				},
			);
		} finally {
			cleanup();
		}
	});
});
