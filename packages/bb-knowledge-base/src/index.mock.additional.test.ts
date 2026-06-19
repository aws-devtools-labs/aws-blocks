// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Additional negative tests for mock KnowledgeBase.
 *
 * These tests verify:
 * 1. Error recovery — a failed load must not permanently poison the instance
 * 2. Non-ASCII retrieval — multilingual content should be searchable (dev/prod parity)
 * 3. Chunking option ignored — mock silently ignores the chunking config
 * 4. Large single-paragraph document handling — shouldn't return entire doc as one chunk
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KnowledgeBase, KnowledgeBaseErrors } from './index.mock.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const CWD = process.cwd();

function freshDir(name: string): string {
	const p = join(CWD, name);
	if (existsSync(p)) rmSync(p, { recursive: true, force: true });
	mkdirSync(p, { recursive: true });
	return p;
}

function cleanupDirs(...names: string[]): void {
	for (const name of names) {
		const p = join(CWD, name);
		try {
			rmSync(p, { recursive: true, force: true });
		} catch {}
	}
}

// ════════════════════════════════════════════════════════════════════════════
// Error recovery — failed load must not permanently poison the instance
// ════════════════════════════════════════════════════════════════════════════

describe('error recovery after failed load', () => {
	test('instance recovers after source folder is created following initial failure', async () => {
		// First call: source folder doesn't exist → should throw InvalidSource
		const srcName = '_error-recovery-src';
		cleanupDirs(srcName);

		const kb = new KnowledgeBase({ id: 'app' }, 'recover', { source: srcName });
		await assert.rejects(
			() => kb.retrieve('test query'),
			(err: Error) => {
				assert.strictEqual(err.name, KnowledgeBaseErrors.InvalidSource);
				return true;
			},
			'First call should fail because source folder does not exist',
		);

		// Now create the source folder with content
		const src = freshDir(srcName);
		writeFileSync(
			join(src, 'doc.md'),
			'This document contains information about recovery testing and transient failures in distributed systems.',
		);

		// Second call on the SAME instance: should recover and find results
		try {
			const results = await kb.retrieve('recovery testing transient failures');
			assert.ok(
				results.length > 0,
				'Instance should recover after source folder is created — loadPromise must not be permanently poisoned',
			);
		} finally {
			cleanupDirs(srcName);
		}
	});

	test('new instance works after previous instance failed with same id', async () => {
		const srcName = '_error-recovery-new';
		cleanupDirs(srcName);

		// First instance: fails
		const kb1 = new KnowledgeBase({ id: 'app' }, 'recov2', { source: srcName });
		await assert.rejects(
			() => kb1.retrieve('anything'),
			(err: Error) => err.name === KnowledgeBaseErrors.InvalidSource,
		);

		// Create the source folder
		const src = freshDir(srcName);
		writeFileSync(
			join(src, 'doc.md'),
			'Document about resilience patterns and error handling in cloud-native applications and microservices.',
		);

		try {
			// New instance with same scope/id: should work fine (control test)
			const kb2 = new KnowledgeBase({ id: 'app' }, 'recov2', { source: srcName });
			const results = await kb2.retrieve('resilience patterns error handling');
			assert.ok(results.length > 0, 'New instance should work (control)');
		} finally {
			cleanupDirs(srcName);
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Non-ASCII retrieval — multilingual content should be searchable
// ════════════════════════════════════════════════════════════════════════════

describe('non-ASCII and multilingual retrieval', () => {
	test('ASCII query works (control for non-ASCII tests)', async () => {
		const src = freshDir('_unicode-control');
		writeFileSync(
			join(src, 'doc.md'),
			'The deployment pipeline automatically validates infrastructure changes before promoting to production environments.',
		);

		try {
			const kb = new KnowledgeBase({ id: 'app' }, 'uni1', { source: '_unicode-control' });
			const results = await kb.retrieve('deployment pipeline infrastructure');
			assert.ok(results.length > 0, 'ASCII query should work (control)');
		} finally {
			cleanupDirs('_unicode-control');
		}
	});

	test('unaccented query finds accented document content via normalization', async () => {
		// A user types "resume" expecting to find "résumé" — requires Unicode normalization.
		// Query uses ONLY the unaccented form of words that appear accented in the doc.
		const src = freshDir('_unicode-normalize');
		writeFileSync(join(src, 'doc.md'), 'Veuillez préparer votre résumé détaillé pour évaluation complète.');

		try {
			const kb = new KnowledgeBase({ id: 'app' }, 'uni2', { source: '_unicode-normalize' });
			const results = await kb.retrieve('resume detaille evaluation');
			assert.ok(
				results.length > 0,
				'Unaccented query "resume detaille evaluation" should find document containing "résumé détaillé évaluation" — ' +
					'tokenizer should normalize accented characters for matching',
			);
		} finally {
			cleanupDirs('_unicode-normalize');
		}
	});

	test('CJK characters are searchable', async () => {
		const src = freshDir('_unicode-cjk');
		writeFileSync(
			join(src, 'doc.md'),
			'機械学習のアルゴリズムはデータ処理を効率化します。人工知能は未来の技術です。',
		);

		try {
			const kb = new KnowledgeBase({ id: 'app' }, 'uni3', { source: '_unicode-cjk' });
			const results = await kb.retrieve('機械学習 人工知能');
			assert.ok(
				results.length > 0,
				'CJK query should find CJK document content — ' +
					'tokenizer must not strip non-ASCII characters entirely',
			);
		} finally {
			cleanupDirs('_unicode-cjk');
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Chunking option — mock should respect fixed-size chunking config
// ════════════════════════════════════════════════════════════════════════════

describe('chunking configuration', () => {
	test('fixed chunking with small chunkSize produces smaller chunks than default', async () => {
		const src = freshDir('_chunking-fixed');
		// Single large paragraph (no blank lines) — about 500 words
		const words = Array.from(
			{ length: 500 },
			(_, i) => `word${i} sentence${i % 50} paragraph content text document knowledge base`,
		).join(' ');
		writeFileSync(join(src, 'big.md'), words);

		try {
			const kbDefault = new KnowledgeBase({ id: 'app' }, 'chunkdef', { source: '_chunking-fixed' });
			const defaultResults = await kbDefault.retrieve('word0 sentence0');

			const kbFixed = new KnowledgeBase({ id: 'app' }, 'chunkfix', {
				source: '_chunking-fixed',
				chunking: { strategy: 'fixed', chunkSize: 50 },
			});
			const fixedResults = await kbFixed.retrieve('word0 sentence0');

			if (defaultResults.length > 0 && fixedResults.length > 0) {
				const defaultMaxLen = Math.max(...defaultResults.map((r) => r.text.length));
				const fixedMaxLen = Math.max(...fixedResults.map((r) => r.text.length));
				assert.ok(
					fixedMaxLen < defaultMaxLen,
					`Fixed chunking (chunkSize=50) should produce smaller chunks than default. ` +
						`Fixed max: ${fixedMaxLen}, Default max: ${defaultMaxLen}. ` +
						'The chunking option appears to be ignored.',
				);
			} else {
				assert.ok(fixedResults.length > 0, 'Fixed chunking should still produce searchable results');
			}
		} finally {
			cleanupDirs('_chunking-fixed');
		}
	});

	test('single large document without blank lines should be chunked, not returned as one block', async () => {
		const src = freshDir('_chunking-single');
		// Create a document with ~2000 characters, no blank lines
		const content = Array.from(
			{ length: 40 },
			(_, i) =>
				`Section ${i}: This is important content about topic ${i} that discusses various aspects of the subject matter in detail.`,
		).join('\n');
		writeFileSync(join(src, 'dense.md'), content);

		try {
			const kb = new KnowledgeBase({ id: 'app' }, 'chunkbig', {
				source: '_chunking-single',
				chunking: { strategy: 'fixed', chunkSize: 100 },
			});
			const results = await kb.retrieve('topic important content');

			assert.ok(results.length > 0, 'Should return results');
			const maxChunkLen = Math.max(...results.map((r) => r.text.length));
			assert.ok(
				maxChunkLen < content.length,
				`No single chunk should contain the entire document (${content.length} chars). ` +
					`Largest chunk was ${maxChunkLen} chars. ` +
					'Document should be split into multiple chunks.',
			);
		} finally {
			cleanupDirs('_chunking-single');
		}
	});
});

// ── Final cleanup ──────────────────────────────────────────────────────────
test('test cleanup', () => {});
