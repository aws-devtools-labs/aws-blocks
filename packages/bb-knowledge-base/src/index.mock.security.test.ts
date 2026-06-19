// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for mock KnowledgeBase security, cache correctness, and filter
 * behavior under realistic corpus sizes.
 *
 * These tests verify:
 * 1. Source path containment — the mock must reject paths that escape the project
 * 2. Cache invalidation — changing source content must be reflected in results
 * 3. Metadata filter completeness — filters must not silently drop valid matches
 */

import { test, beforeEach, describe } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { KnowledgeBase, KnowledgeBaseErrors } from './index.mock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

beforeEach(() => {});

// ════════════════════════════════════════════════════════════════════════════
// Path containment — source must be within the project directory
// ════════════════════════════════════════════════════════════════════════════

describe('source path containment', () => {
	test('rejects source that resolves to a sibling directory sharing the cwd prefix', () => {
		// A sibling dir like /a/proj-secrets passes a naive startsWith check
		// against /a/proj because the string prefix matches. The guard must
		// use path-separator-aware comparison.
		const base = freshDir('_path-guard-base');
		const proj = join(base, 'proj');
		mkdirSync(proj, { recursive: true });
		const sibling = join(base, 'proj-secrets');
		mkdirSync(sibling, { recursive: true });
		writeFileSync(
			join(sibling, 'secret.md'),
			'This is a secret document that should never be accessible from the project directory.',
		);

		try {
			// Run in a subprocess with cwd=proj so resolve(cwd) = .../proj
			const distPath = join(__dirname, 'index.mock.js').replace(/\\/g, '/');
			const script = `
import { KnowledgeBase, KnowledgeBaseErrors } from '${distPath}';
try {
	const kb = new KnowledgeBase({ id: 'app' }, 'leak', { source: '../proj-secrets' });
	const r = await kb.retrieve('secret document');
	if (r.length > 0) {
		process.exit(1); // Read files from outside project
	}
	process.exit(1); // No error thrown — guard did not block
} catch (e) {
	if (e.name === '${KnowledgeBaseErrors.InvalidSource}') {
		process.exit(0); // Correctly blocked
	}
	process.exit(2); // Unexpected error type
}
`;
			const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
				cwd: proj,
				encoding: 'utf8',
				timeout: 10000,
			});

			assert.strictEqual(
				res.status,
				0,
				`Expected InvalidSourceConfigException for sibling dir. ` +
					`Exit code ${res.status}. stdout: ${res.stdout}. stderr: ${res.stderr}`,
			);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test('rejects source with .. that escapes project directory', async () => {
		const outside = freshDir('_path-guard-outside');
		writeFileSync(
			join(outside, 'data.txt'),
			'Sensitive data that lives outside the project root and must not be reachable via relative paths.',
		);

		try {
			const kb = new KnowledgeBase({ id: 'app' }, 'escape', {
				source: join('..', '_path-guard-outside'),
			});
			await assert.rejects(
				() => kb.retrieve('sensitive data'),
				(err: Error) => {
					assert.strictEqual(err.name, KnowledgeBaseErrors.InvalidSource);
					return true;
				},
				'Should throw InvalidSource for paths escaping project via ..',
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test('rejects absolute path outside project', async () => {
		const outside = freshDir('_path-guard-abs');
		writeFileSync(join(outside, 'doc.md'), 'Absolute path document content for testing path guard enforcement.');

		try {
			const kb = new KnowledgeBase({ id: 'app' }, 'abs', { source: outside });
			await assert.rejects(
				() => kb.retrieve('absolute path document'),
				(err: Error) => {
					assert.strictEqual(err.name, KnowledgeBaseErrors.InvalidSource);
					return true;
				},
				'Should throw InvalidSource for absolute paths outside project',
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test('allows valid relative path within project', async () => {
		const valid = freshDir('_path-guard-valid');
		writeFileSync(
			join(valid, 'doc.md'),
			'This is a valid document inside the project directory for testing path acceptance.',
		);

		try {
			const kb = new KnowledgeBase({ id: 'app' }, 'valid', { source: '_path-guard-valid' });
			const results = await kb.retrieve('valid document inside project');
			assert.ok(results.length > 0, 'Should return results for valid in-project source');
		} finally {
			cleanupDirs('_path-guard-valid');
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Cache invalidation — results must reflect current source content
// ════════════════════════════════════════════════════════════════════════════

describe('cache invalidation', () => {
	test('changing source folder returns new content, not stale cache', async () => {
		const v1 = freshDir('_cache-v1');
		writeFileSync(
			join(v1, 'doc.md'),
			'Version one content about apples oranges and fruit orchards in the countryside.',
		);
		const v2 = freshDir('_cache-v2');
		writeFileSync(
			join(v2, 'doc.md'),
			'Version two content about spaceships rockets and interstellar galactic travel.',
		);

		try {
			// First instance: source = v1
			const kb1 = new KnowledgeBase({ id: 'app' }, 'cache', { source: '_cache-v1' });
			const r1 = await kb1.retrieve('apples oranges fruit');
			assert.ok(r1.length > 0, 'v1 query should return results');
			assert.ok(
				r1[0].text.includes('apples') || r1[0].text.includes('oranges'),
				'v1 results should contain v1 content',
			);

			// Second instance: SAME fullId, DIFFERENT source folder
			const kb2 = new KnowledgeBase({ id: 'app' }, 'cache', { source: '_cache-v2' });
			const r2 = await kb2.retrieve('spaceships rockets galactic');
			assert.ok(r2.length > 0, 'Query for v2 content should return results when source points to v2');
			assert.ok(
				r2[0].text.includes('spaceships') || r2[0].text.includes('rockets'),
				'Results should contain v2 content, not stale v1 data',
			);
		} finally {
			cleanupDirs('_cache-v1', '_cache-v2');
		}
	});

	test('editing a document in the source folder is reflected on next load', async () => {
		const src = freshDir('_cache-edit');
		writeFileSync(
			join(src, 'doc.md'),
			'Original content about dinosaurs and prehistoric creatures from the Jurassic period.',
		);

		try {
			const kb1 = new KnowledgeBase({ id: 'app' }, 'edit', { source: '_cache-edit' });
			const r1 = await kb1.retrieve('dinosaurs prehistoric Jurassic');
			assert.ok(r1.length > 0, 'original query should match');

			// Edit the document
			writeFileSync(
				join(src, 'doc.md'),
				'Updated content about quantum computing and artificial intelligence breakthroughs in modern science.',
			);

			// New instance with same id and same source path
			const kb2 = new KnowledgeBase({ id: 'app' }, 'edit', { source: '_cache-edit' });
			const r2 = await kb2.retrieve('quantum computing artificial intelligence');
			assert.ok(r2.length > 0, 'Query for updated content should return results after document edit');
			assert.ok(
				r2[0].text.includes('quantum') || r2[0].text.includes('artificial'),
				'Results should reflect the edited content',
			);

			// Old content should no longer match
			const r3 = await kb2.retrieve('dinosaurs prehistoric Jurassic');
			assert.strictEqual(r3.length, 0, 'Old content should not be returned after document edit');
		} finally {
			cleanupDirs('_cache-edit');
		}
	});

	test('adding a new document to source folder is picked up on next load', async () => {
		const src = freshDir('_cache-add');
		writeFileSync(
			join(src, 'original.md'),
			'Original document about cooking recipes and kitchen techniques for beginners.',
		);

		try {
			const kb1 = new KnowledgeBase({ id: 'app' }, 'add', { source: '_cache-add' });
			await kb1.retrieve('cooking recipes');

			// Add a new document
			writeFileSync(
				join(src, 'new.md'),
				'Brand new document about underwater photography and marine biology exploration techniques.',
			);

			// New instance
			const kb2 = new KnowledgeBase({ id: 'app' }, 'add', { source: '_cache-add' });
			const r2 = await kb2.retrieve('underwater photography marine biology');
			assert.ok(r2.length > 0, 'Newly added document should be found after re-instantiation');
			assert.ok(
				r2.some((r) => r.source === 'new.md'),
				'Results should include the newly added document',
			);
		} finally {
			cleanupDirs('_cache-add');
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Metadata filter completeness — filters must not silently drop valid matches
// ════════════════════════════════════════════════════════════════════════════

describe('metadata filter completeness', () => {
	test('filter returns all matching docs even when they rank below higher-scoring non-matching docs', async () => {
		// When many non-matching docs score higher than matching docs, the filter
		// must still find and return the matching docs up to maxResults.
		const src = freshDir('_filter-completeness');
		mkdirSync(join(src, 'target'), { recursive: true });
		mkdirSync(join(src, 'noise'), { recursive: true });

		// 200 noise docs that strongly match "apple" (high TF-IDF score)
		for (let i = 0; i < 200; i++) {
			writeFileSync(
				join(src, 'noise', `n${i}.md`),
				'apple apple apple apple apple fruit orchard harvest season picking baskets cider juice.',
			);
		}
		// 5 target docs in folder=target that mention "apple" with lower density
		for (let i = 0; i < 5; i++) {
			writeFileSync(
				join(src, 'target', `t${i}.md`),
				`Target document ${i} that mentions apple once amid many other unrelated words and topics and themes and ideas and concepts here.`,
			);
		}

		try {
			const kb = new KnowledgeBase({ id: 'app' }, 'filtcomp', { source: '_filter-completeness' });
			const results = await kb.retrieve('apple', {
				maxResults: 5,
				filter: { folder: { equals: 'target' } },
			});

			assert.strictEqual(
				results.length,
				5,
				`Expected 5 results from target folder, got ${results.length}. ` +
					'Filter must scan all matching docs regardless of score ranking.',
			);
			for (const r of results) {
				assert.strictEqual(r.metadata.folder, 'target');
			}
		} finally {
			cleanupDirs('_filter-completeness');
		}
	});

	test('filter with maxResults=1 finds the one matching doc in a large corpus', async () => {
		const src = freshDir('_filter-single');
		mkdirSync(join(src, 'special'), { recursive: true });
		mkdirSync(join(src, 'common'), { recursive: true });

		// 100 common docs with high relevance for "database"
		for (let i = 0; i < 100; i++) {
			writeFileSync(
				join(src, 'common', `c${i}.md`),
				'database database database query optimization indexing performance tuning sharding replication.',
			);
		}
		// 1 special doc that also mentions "database" but with lower density
		writeFileSync(
			join(src, 'special', 'unique.md'),
			'This special document discusses database concepts alongside many other software engineering topics and practices.',
		);

		try {
			const kb = new KnowledgeBase({ id: 'app' }, 'filtsingle', { source: '_filter-single' });
			const results = await kb.retrieve('database', {
				maxResults: 1,
				filter: { folder: { equals: 'special' } },
			});

			assert.strictEqual(
				results.length,
				1,
				'Should find the one matching doc in special folder despite 100 higher-scoring common docs',
			);
			assert.strictEqual(results[0].metadata.folder, 'special');
			assert.ok(results[0].source.includes('special/'));
		} finally {
			cleanupDirs('_filter-single');
		}
	});

	test('filter works correctly when matching docs have highest scores (control)', async () => {
		// Control: when matching docs score highest, filter works regardless of implementation
		const src = freshDir('_filter-control');
		mkdirSync(join(src, 'target'), { recursive: true });
		mkdirSync(join(src, 'other'), { recursive: true });

		// Target docs have HIGH relevance for "zebra"
		for (let i = 0; i < 3; i++) {
			writeFileSync(
				join(src, 'target', `t${i}.md`),
				'zebra zebra zebra zebra zebra stripes savanna Africa wildlife safari migration patterns.',
			);
		}
		// Other docs have LOW relevance for "zebra"
		writeFileSync(
			join(src, 'other', 'o.md'),
			'This document barely mentions zebra once among many other animal species and topics.',
		);

		try {
			const kb = new KnowledgeBase({ id: 'app' }, 'filtctrl', { source: '_filter-control' });
			const results = await kb.retrieve('zebra', {
				maxResults: 3,
				filter: { folder: { equals: 'target' } },
			});

			assert.strictEqual(results.length, 3, 'Should find all 3 target docs when they score highest');
		} finally {
			cleanupDirs('_filter-control');
		}
	});
});

// ── Final cleanup ──────────────────────────────────────────────────────────
test('test cleanup', () => {});
