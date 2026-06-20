// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, beforeEach, describe } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, mkdirSync, writeFileSync, cpSync, symlinkSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { KnowledgeBase, KnowledgeBaseErrors } from './index.mock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const FIXTURES_SRC = join(PKG_ROOT, 'test-fixtures', 'knowledge');
const TEST_KNOWLEDGE_NAME = 'test-knowledge-tmp';
const TEST_KNOWLEDGE = join(process.cwd(), TEST_KNOWLEDGE_NAME);

function setupTestFixtures(): void {
	if (existsSync(TEST_KNOWLEDGE)) rmSync(TEST_KNOWLEDGE, { recursive: true, force: true });
	cpSync(FIXTURES_SRC, TEST_KNOWLEDGE, { recursive: true });
}

function cleanup(): void {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch {}
	try { rmSync(TEST_KNOWLEDGE, { recursive: true, force: true }); } catch {}
}

// Helpers for tests that build their own temporary corpora under the project
// directory (path-guard, cache, filter, load-recovery, chunking, unicode).
const CWD = process.cwd();

function freshDir(name: string): string {
	const p = join(CWD, name);
	if (existsSync(p)) rmSync(p, { recursive: true, force: true });
	mkdirSync(p, { recursive: true });
	return p;
}

function cleanupDirs(...names: string[]): void {
	for (const name of names) {
		try { rmSync(join(CWD, name), { recursive: true, force: true }); } catch {}
	}
}

beforeEach(() => {
	cleanup();
	setupTestFixtures();
});

// ── Basic retrieve ─────────────────────────────────────────────────────────

test('retrieve returns results matching query terms', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'kb', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('password reset');

	assert.ok(results.length > 0, 'should return results');
	assert.ok(
		results[0].text.toLowerCase().includes('password'),
		'top result should contain password',
	);
});

test('retrieve returns results for billing query', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'kb', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('billing payment invoice');

	assert.ok(results.length > 0, 'should return results');
	assert.ok(
		results.some(r => r.source.includes('billing')),
		'should include billing source',
	);
});

// ── Score ordering ─────────────────────────────────────────────────────────

test('results are sorted by score descending', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'kb', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('API authentication token');

	assert.ok(results.length >= 2, 'should return multiple results');
	for (let i = 1; i < results.length; i++) {
		assert.ok(
			results[i - 1].score >= results[i].score,
			`score[${i - 1}] (${results[i - 1].score}) should be >= score[${i}] (${results[i].score})`,
		);
	}
});

// ── maxResults ─────────────────────────────────────────────────────────────

test('maxResults limits number of returned results', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'kb', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('the', { maxResults: 2 });

	assert.ok(results.length <= 2, 'should return at most 2');
});

test('maxResults is clamped to [1, 100]', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'kb', { source: 'test-knowledge-tmp' });

	const results0 = await kb.retrieve('password', { maxResults: 0 });
	assert.ok(results0.length >= 1, 'maxResults=0 should clamp to 1');

	const resultsNeg = await kb.retrieve('password', { maxResults: -5 });
	assert.ok(resultsNeg.length >= 1, 'negative maxResults should clamp to 1');
});

// ── Empty results ──────────────────────────────────────────────────────────

test('unrelated query returns empty array', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'kb', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('xyzzy quantum entanglement supercalifragilistic');

	assert.strictEqual(results.length, 0, 'should return no results');
});

// ── Subfolder → folder metadata ────────────────────────────────────────────

test('faq files get folder metadata "faq"', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'kb', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('password reset');

	const faqResult = results.find(r => r.source.includes('faq/'));
	assert.ok(faqResult, 'should have result from faq folder');
	assert.strictEqual(faqResult.metadata.folder, 'faq', 'folder metadata should be "faq"');
});

test('nested subfolder gets first-level folder as folder metadata', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'kb', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('API authentication OAuth');

	const advancedResult = results.find(r => r.source.includes('guides/advanced/'));
	assert.ok(advancedResult, 'should have result from guides/advanced');
	assert.strictEqual(
		advancedResult.metadata.folder,
		'guides',
		'nested folder metadata should be first-level folder "guides"',
	);
});

test('root-level files have no folder metadata', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'kb', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('release notes performance improvements');

	const rootResult = results.find(r => r.source === 'release-notes.txt');
	assert.ok(rootResult, 'should have result from root file');
	assert.strictEqual(rootResult.metadata.folder, undefined, 'root file should have no folder metadata');
});

// ── Metadata filter ────────────────────────────────────────────────────────

test('metadata filter restricts results to matching folder', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'kb', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('password billing guide', {
		filter: { folder: { equals: 'faq' } },
	});

	assert.ok(results.length > 0, 'should return results');
	for (const r of results) {
		assert.strictEqual(r.metadata.folder, 'faq', 'all results should be from faq folder');
	}
});

test('non-existent filter value returns empty array', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'kb', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('password', {
		filter: { folder: { equals: 'nonexistent' } },
	});

	assert.strictEqual(results.length, 0);
});

// ── RetrieveResult shape ───────────────────────────────────────────────────

test('RetrieveResult has all required fields with correct types', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'kb', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('password');

	assert.ok(results.length > 0);
	const r = results[0];
	assert.strictEqual(typeof r.text, 'string', 'text should be string');
	assert.ok(r.text.length > 0, 'text should be non-empty');
	assert.strictEqual(typeof r.score, 'number', 'score should be number');
	assert.ok(r.score >= 0 && r.score <= 1, 'score should be in [0, 1]');
	assert.strictEqual(typeof r.source, 'string', 'source should be string');
	assert.ok(r.source.length > 0, 'source should be non-empty');
	assert.strictEqual(typeof r.metadata, 'object', 'metadata should be object');
	assert.ok(r.metadata !== null, 'metadata should not be null');
});

// ── Persistence ────────────────────────────────────────────────────────────

test('second instance reuses chunks.json cache when the source is unchanged', async () => {
	const kb1 = new KnowledgeBase({ id: 'test' }, 'persist', { source: 'test-knowledge-tmp' });
	const results1 = await kb1.retrieve('password');
	assert.ok(results1.length > 0);

	const cachePath = join('.bb-data', 'test-persist', 'chunks.json');
	assert.ok(existsSync(cachePath), 'chunks.json cache should exist');

	// Overwrite the cache with a sentinel chunk while leaving the source (and its
	// source.hash fingerprint) untouched. A second instance that reads the cache —
	// rather than re-reading the source — will surface the sentinel, proving the
	// cache is reused when the source is unchanged.
	const sentinel = 'zzqxmarker unique sentinel chunk present only in the cache file content here';
	writeFileSync(cachePath, JSON.stringify([{ text: sentinel, source: 'sentinel.md', metadata: {} }]));

	const kb2 = new KnowledgeBase({ id: 'test' }, 'persist', { source: 'test-knowledge-tmp' });
	const results2 = await kb2.retrieve('zzqxmarker sentinel');
	assert.ok(results2.length > 0, 'should load chunks from cache');
	assert.ok(
		results2[0].text.includes('zzqxmarker'),
		'cached sentinel chunk should be returned, proving the cache was reused',
	);
});

// ── S3 URI source ──────────────────────────────────────────────────────────

test('S3 URI source throws InvalidSource with actionable message', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 's3kb', {
		source: 's3://my-docs-bucket/prefix/',
	});
	await assert.rejects(
		() => kb.retrieve('test'),
		(err: Error) => {
			assert.strictEqual(err.name, KnowledgeBaseErrors.InvalidSource);
			assert.ok(err.message.includes('S3 URI'), 'should mention S3 URI');
			assert.ok(err.message.includes('local folder path'), 'should suggest local folder');
			return true;
		},
	);
});

// ── Validation ─────────────────────────────────────────────────────────────

test('empty query throws ValidationError', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'kb', { source: 'test-knowledge-tmp' });
	await assert.rejects(
		() => kb.retrieve(''),
		(err: Error) => err.name === KnowledgeBaseErrors.ValidationError,
	);
});

test('whitespace-only query throws ValidationError', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'kb', { source: 'test-knowledge-tmp' });
	await assert.rejects(
		() => kb.retrieve('   '),
		(err: Error) => err.name === KnowledgeBaseErrors.ValidationError,
	);
});

// ── Unsupported file types ─────────────────────────────────────────────────

test('unsupported file types are skipped without error', async () => {
	// Add an unsupported binary file to the test knowledge dir
	writeFileSync(join(TEST_KNOWLEDGE, 'image.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));
	writeFileSync(join(TEST_KNOWLEDGE, 'doc.pdf'), 'fake pdf content');

	const kb = new KnowledgeBase({ id: 'test' }, 'skip', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('password');

	assert.ok(results.length > 0, 'should still return results from supported files');
	assert.ok(
		!results.some(r => r.source.endsWith('.png') || r.source.endsWith('.pdf')),
		'should not include unsupported file results',
	);
});

// ── Invalid source ─────────────────────────────────────────────────────────

test('missing source folder throws InvalidSource', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'kb', { source: 'nonexistent-folder-xyz' });
	await assert.rejects(
		() => kb.retrieve('test'),
		(err: Error) => err.name === KnowledgeBaseErrors.InvalidSource,
	);
});

// ── fullId ─────────────────────────────────────────────────────────────────

test('fullId generation matches scope pattern', () => {
	const kb = new KnowledgeBase({ id: 'myapp' }, 'docs', { source: 'test-knowledge-tmp' });
	assert.strictEqual(kb.fullId, 'myapp-docs');
});

// ── Empty source folder ────────────────────────────────────────────────────

test('empty source folder returns empty results', async () => {
	const emptyDir = join(process.cwd(), 'test-empty-knowledge-tmp');
	if (existsSync(emptyDir)) rmSync(emptyDir, { recursive: true, force: true });
	mkdirSync(emptyDir, { recursive: true });

	try {
		const kb = new KnowledgeBase({ id: 'test' }, 'empty', { source: 'test-empty-knowledge-tmp' });
		const results = await kb.retrieve('anything');
		assert.strictEqual(results.length, 0);
	} finally {
		rmSync(emptyDir, { recursive: true, force: true });
	}
});

// ── Folder with only unsupported files ─────────────────────────────────────

test('folder with only unsupported files returns empty results', async () => {
	const unsupportedDir = join(process.cwd(), 'test-unsupported-knowledge-tmp');
	if (existsSync(unsupportedDir)) rmSync(unsupportedDir, { recursive: true, force: true });
	mkdirSync(unsupportedDir, { recursive: true });
	writeFileSync(join(unsupportedDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));
	writeFileSync(join(unsupportedDir, 'data.bin'), Buffer.from([0x00, 0x01, 0x02]));
	writeFileSync(join(unsupportedDir, 'doc.pdf'), 'fake pdf');

	try {
		const kb = new KnowledgeBase({ id: 'test' }, 'unsup', { source: 'test-unsupported-knowledge-tmp' });
		const results = await kb.retrieve('anything');
		assert.strictEqual(results.length, 0);
	} finally {
		rmSync(unsupportedDir, { recursive: true, force: true });
	}
});

// ── Short paragraphs filtered ──────────────────────────────────────────────

test('short paragraphs under 20 chars are filtered out', async () => {
	const shortDir = join(process.cwd(), 'test-short-knowledge-tmp');
	if (existsSync(shortDir)) rmSync(shortDir, { recursive: true, force: true });
	mkdirSync(shortDir, { recursive: true });
	writeFileSync(join(shortDir, 'doc.md'), 'Short.\n\nAlso tiny.\n\nThis paragraph is definitely long enough to be included in the index results.');

	try {
		const kb = new KnowledgeBase({ id: 'test' }, 'short', { source: 'test-short-knowledge-tmp' });
		const results = await kb.retrieve('paragraph included index results');
		assert.ok(results.length > 0, 'should return the long paragraph');
		for (const r of results) {
			assert.ok(r.text.length >= 20, `chunk "${r.text}" should be >= 20 chars`);
		}
	} finally {
		rmSync(shortDir, { recursive: true, force: true });
	}
});

// ── Multiple metadata filters (AND semantics) ─────────────────────────────

test('multiple metadata filters use AND semantics', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'andfilt', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('password billing API token reset guide', {
		filter: {
			folder: { equals: 'faq' },
		},
	});

	for (const r of results) {
		assert.strictEqual(r.metadata.folder, 'faq');
	}

	const noResults = await kb.retrieve('password billing', {
		filter: {
			folder: { equals: 'faq' },
			nonexistent_key: { equals: 'nonexistent_value' },
		},
	});
	assert.strictEqual(noResults.length, 0, 'AND of impossible filter should return empty');
});

// ── maxResults upper bound clamped ─────────────────────────────────────────

test('maxResults clamped to maximum 100', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'clamp', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('the', { maxResults: 500 });
	assert.ok(results.length <= 100);
});

// ── Concurrent retrieve calls ──────────────────────────────────────────────

test('concurrent retrieve calls work correctly', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'concurrent', { source: 'test-knowledge-tmp' });
	const [r1, r2, r3] = await Promise.all([
		kb.retrieve('password'),
		kb.retrieve('billing'),
		kb.retrieve('API'),
	]);
	assert.ok(r1.length > 0, 'password query should return results');
	assert.ok(r2.length > 0, 'billing query should return results');
	assert.ok(r3.length > 0, 'API query should return results');
});

// ── Cache corruption recovery ──────────────────────────────────────────────

test('rebuilds index when cache is corrupted', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'corrupt-test', { source: 'test-knowledge-tmp' });
	await kb.retrieve('test query');

	const cachePath = join('.bb-data', 'test-corrupt-test', 'chunks.json');
	assert.ok(existsSync(cachePath), 'Cache file should exist');

	writeFileSync(cachePath, '{ INVALID JSON !!!');

	const kb2 = new KnowledgeBase({ id: 'test' }, 'corrupt-test', { source: 'test-knowledge-tmp' });
	const results = await kb2.retrieve('password');
	assert.ok(results.length > 0, 'Should recover from corrupt cache and return results');
});

// ── Customer-provided .metadata.json sidecar ───────────────────────────────

test('customer-provided metadata.json is used instead of auto-generated folder', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'custmeta', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('deploying applications production staging');

	const tutorialResult = results.find(r => r.source.includes('tutorials/'));
	assert.ok(tutorialResult, 'should have result from tutorials folder');
	assert.strictEqual(tutorialResult.metadata.category, 'deployment', 'should have customer category metadata');
	assert.strictEqual(tutorialResult.metadata.difficulty, 'intermediate', 'should have customer difficulty metadata');
	assert.strictEqual(tutorialResult.metadata.folder, undefined, 'should NOT have auto-generated folder metadata when customer sidecar exists');
});

test('filter by customer-provided metadata returns only matching docs', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'custfilt', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('password billing deployment guide', {
		filter: { category: { equals: 'deployment' } },
	});

	assert.ok(results.length > 0, 'should return results for category=deployment');
	for (const r of results) {
		assert.strictEqual(r.metadata.category, 'deployment', 'all results should have category=deployment');
	}
});

test('filter by customer-provided metadata with non-matching value returns empty', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'custnomatch', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('deployment guide', {
		filter: { category: { equals: 'nonexistent' } },
	});

	assert.strictEqual(results.length, 0, 'non-matching customer metadata filter should return empty');
});

test('auto-generated folder metadata still works for docs without sidecar', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'autocoexist', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('password reset billing', { maxResults: 20 });

	const faqResult = results.find(r => r.source.includes('faq/'));
	assert.ok(faqResult, 'should have result from faq folder');
	assert.strictEqual(faqResult.metadata.folder, 'faq', 'faq docs should still have auto-generated folder metadata');
	assert.strictEqual(faqResult.metadata.category, undefined, 'faq docs should NOT have customer category metadata');
});

test('metadata.json sidecar files are not indexed as documents', async () => {
	const kb = new KnowledgeBase({ id: 'test' }, 'nosidecaridx', { source: 'test-knowledge-tmp' });
	const results = await kb.retrieve('metadataAttributes stringValue type STRING', { maxResults: 50 });

	for (const r of results) {
		assert.ok(
			!r.source.endsWith('.metadata.json'),
			`should not index .metadata.json files as documents, but found: ${r.source}`,
		);
	}
});

// ── Source path containment (path-guard) ───────────────────────────────────
//
// The mock must reject sources that escape the project directory. The guard
// uses path-separator-aware comparison so a sibling directory that merely
// shares the cwd string prefix (e.g. /a/proj-secrets vs /a/proj) is NOT
// treated as inside the project.

describe('source path containment', () => {
	test('rejects sibling directory that shares the cwd string prefix', () => {
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
			// Run in a subprocess with cwd=proj so resolve(cwd) = .../proj. __dirname
			// resolves to the compiled dist/ directory, where index.mock.js sits beside
			// this test. Build the ESM specifier as a file:// URL so it is valid on
			// every platform (a bare Windows path like C:\... is not a legal ESM
			// specifier). Requires a prior `tsc` build — this test runs against dist/.
			const distUrl = pathToFileURL(join(__dirname, 'index.mock.js')).href;
			const script = `
import { KnowledgeBase, KnowledgeBaseErrors } from '${distUrl}';
try {
	const kb = new KnowledgeBase({ id: 'app' }, 'leak', { source: '../proj-secrets' });
	await kb.retrieve('secret document');
	process.exit(1); // retrieve resolved — guard failed to block
} catch (e) {
	if (e.name === '${KnowledgeBaseErrors.InvalidSource}') {
		process.exit(0); // correctly blocked
	}
	process.exit(2); // unexpected error type
}
`;
			const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
				cwd: proj,
				encoding: 'utf8',
				timeout: 10000,
			});

			// res.status === 0 means the guard correctly threw InvalidSource and the
			// subprocess exited cleanly. A non-zero status has causes that must NOT be
			// conflated with a guard bug, so rule them out before the real assertion:
			//   • res.error set → the subprocess could not be spawned or timed out
			//     (infrastructure issue, not a guard failure).
			//   • ERR_MODULE_NOT_FOUND on stderr → the compiled dist/index.mock.js is
			//     missing or stale, so the static `import` fails BEFORE the in-script
			//     try/catch runs. Fix by building first; this is not a guard bug.
			// Only once those are excluded does a non-zero exit mean a genuine failure:
			//   exit 1 = retrieve() resolved (guard did not block the sibling dir),
			//   exit 2 = retrieve() threw a non-InvalidSource error.
			const stderr = res.stderr ?? '';
			assert.ok(
				res.error == null,
				`Subprocess could not run to completion (spawn error or timeout): ` +
					`${res.error?.message}. Environment issue, not a guard failure.`,
			);
			assert.ok(
				!/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(stderr),
				`Subprocess could not import compiled dist/index.mock.js — the dist build is ` +
					`missing or stale. Build the package first ` +
					`(\`npm run build -w packages/bb-knowledge-base\`), then re-run. stderr: ${stderr}`,
			);
			assert.strictEqual(
				res.status,
				0,
				`Path guard failed to block a sibling dir that shares the cwd string prefix. ` +
					`Exit ${res.status}: 1 = retrieve() resolved (guard did not block), ` +
					`2 = retrieve() threw a non-InvalidSource error. ` +
					`stdout: ${res.stdout}. stderr: ${stderr}`,
			);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test('rejects source with .. that escapes the project directory', async () => {
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

	test('rejects absolute path outside the project', async () => {
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

	test('rejects a symlink whose target is outside the project', async () => {
		// A symlink inside the project that points at a real target outside it
		// passes lexical containment but must be rejected by the realpath check.
		// The target lives in the OS temp dir (outside the project). Symlink
		// creation is skipped where the platform/CI forbids it (e.g. Windows
		// without privilege), keeping the test portable.
		const outsideTarget = mkdtempSync(join(tmpdir(), 'kb-symlink-target-'));
		writeFileSync(
			join(outsideTarget, 'secret.md'),
			'Secret content that lives outside the project and must not be reachable through a symlink.',
		);
		const linkName = '_symlink-escape';
		const linkPath = join(CWD, linkName);
		try {
			rmSync(linkPath, { recursive: true, force: true });
		} catch {}

		let symlinkOk = true;
		try {
			symlinkSync(outsideTarget, linkPath, 'dir');
		} catch (err) {
			symlinkOk = false;
			console.warn(`Skipping symlink test — cannot create symlink on this platform: ${(err as Error).message}`);
		}

		try {
			if (!symlinkOk) return;
			const kb = new KnowledgeBase({ id: 'app' }, 'symlink', { source: linkName });
			await assert.rejects(
				() => kb.retrieve('secret content'),
				(err: Error) => {
					assert.strictEqual(err.name, KnowledgeBaseErrors.InvalidSource);
					return true;
				},
				'A symlink pointing outside the project must be rejected with InvalidSource',
			);
		} finally {
			rmSync(linkPath, { recursive: true, force: true });
			rmSync(outsideTarget, { recursive: true, force: true });
		}
	});
});

// ── Cache invalidation ──────────────────────────────────────────────────────
//
// The chunks cache is keyed on the source folder's contents (path plus per-file
// mtime/size) and the chunking config. Changing the source or the chunking
// config must rebuild the index rather than serving stale results, and deleting
// the source must throw rather than serving stale cache.

describe('cache invalidation', () => {
	test('switching the source folder returns new content, not stale cache', async () => {
		const v1 = freshDir('_cache-v1');
		writeFileSync(join(v1, 'doc.md'), 'Version one content about apples oranges and fruit orchards in the countryside.');
		const v2 = freshDir('_cache-v2');
		writeFileSync(join(v2, 'doc.md'), 'Version two content about spaceships rockets and interstellar galactic travel.');

		try {
			const kb1 = new KnowledgeBase({ id: 'app' }, 'cache', { source: '_cache-v1' });
			const r1 = await kb1.retrieve('apples oranges fruit');
			assert.ok(r1.length > 0, 'v1 query should return results');
			assert.ok(
				r1[0].text.includes('apples') || r1[0].text.includes('oranges'),
				'v1 results should contain v1 content',
			);

			// Same fullId, different source folder — must not reuse the v1 cache.
			const kb2 = new KnowledgeBase({ id: 'app' }, 'cache', { source: '_cache-v2' });
			const r2 = await kb2.retrieve('spaceships rockets galactic');
			assert.ok(r2.length > 0, 'v2 query should return results when source points to v2');
			assert.ok(
				r2[0].text.includes('spaceships') || r2[0].text.includes('rockets'),
				'results should contain v2 content, not stale v1 data',
			);
		} finally {
			cleanupDirs('_cache-v1', '_cache-v2');
		}
	});

	test('editing a document in the source folder is reflected on next load', async () => {
		const src = freshDir('_cache-edit');
		writeFileSync(join(src, 'doc.md'), 'Original content about dinosaurs and prehistoric creatures from the Jurassic period.');

		try {
			const kb1 = new KnowledgeBase({ id: 'app' }, 'edit', { source: '_cache-edit' });
			const r1 = await kb1.retrieve('dinosaurs prehistoric Jurassic');
			assert.ok(r1.length > 0, 'original query should match');

			writeFileSync(join(src, 'doc.md'), 'Updated content about quantum computing and artificial intelligence breakthroughs in modern science.');

			const kb2 = new KnowledgeBase({ id: 'app' }, 'edit', { source: '_cache-edit' });
			const r2 = await kb2.retrieve('quantum computing artificial intelligence');
			assert.ok(r2.length > 0, 'updated content should return results after edit');
			assert.ok(
				r2[0].text.includes('quantum') || r2[0].text.includes('artificial'),
				'results should reflect the edited content',
			);

			const r3 = await kb2.retrieve('dinosaurs prehistoric Jurassic');
			assert.strictEqual(r3.length, 0, 'old content should not be returned after the document edit');
		} finally {
			cleanupDirs('_cache-edit');
		}
	});

	test('deleting the source after a cached load throws InvalidSource, not stale data', async () => {
		const srcName = '_cache-then-delete';
		const src = freshDir(srcName);
		writeFileSync(
			join(src, 'doc.md'),
			'Content about renewable energy and sustainable power generation technologies worldwide.',
		);

		try {
			const kb1 = new KnowledgeBase({ id: 'app' }, 'deltest', { source: srcName });
			const r1 = await kb1.retrieve('renewable energy sustainable');
			assert.ok(r1.length > 0, 'first load should return results');
			assert.ok(
				existsSync(join('.bb-data', 'app-deltest', 'chunks.json')),
				'cache should be written after the first load',
			);

			// Remove the source folder. A fresh instance must NOT serve the stale
			// cache — the empty source hash forces a rebuild, which throws.
			rmSync(src, { recursive: true, force: true });

			const kb2 = new KnowledgeBase({ id: 'app' }, 'deltest', { source: srcName });
			await assert.rejects(
				() => kb2.retrieve('renewable energy sustainable'),
				(err: Error) => {
					assert.strictEqual(err.name, KnowledgeBaseErrors.InvalidSource);
					return true;
				},
				'Deleting the source must throw InvalidSource rather than serve stale cached chunks',
			);
		} finally {
			cleanupDirs(srcName);
		}
	});

	test('changing the chunking config for the same kb id invalidates the cache and re-chunks', async () => {
		const srcName = '_chunk-cache-key';
		const src = freshDir(srcName);
		// One large no-blank-line paragraph: 'semantic' yields a single big chunk,
		// while 'fixed' with a small chunkSize yields many small chunks.
		const words = Array.from({ length: 400 }, (_, i) => `term${i} alpha beta gamma`).join(' ');
		writeFileSync(join(src, 'big.md'), words);

		try {
			// First load with default (semantic) chunking under id 'chunkkey'.
			const kb1 = new KnowledgeBase({ id: 'app' }, 'chunkkey', { source: srcName });
			const r1 = await kb1.retrieve('term0 alpha');
			assert.ok(r1.length > 0, 'semantic load should return results');
			const semanticMaxLen = Math.max(...r1.map((r) => r.text.length));

			// Same id + same source, but switch to fixed/small chunking. The cache key
			// must include the chunking config, so this rebuilds rather than serving
			// the previously-cached semantic chunks.
			const kb2 = new KnowledgeBase({ id: 'app' }, 'chunkkey', {
				source: srcName,
				chunking: { strategy: 'fixed', chunkSize: 30 },
			});
			const r2 = await kb2.retrieve('term0 alpha');
			assert.ok(r2.length > 0, 'fixed load should return results');
			const fixedMaxLen = Math.max(...r2.map((r) => r.text.length));

			assert.ok(
				fixedMaxLen < semanticMaxLen,
				`Fixed chunking should re-chunk into smaller chunks (fixed max ${fixedMaxLen} < semantic max ${semanticMaxLen}). ` +
					'If equal, the cache key ignored the chunking config and served stale semantic chunks.',
			);
		} finally {
			cleanupDirs(srcName);
		}
	});
});

// ── Metadata filter completeness ────────────────────────────────────────────
//
// When a filter is supplied the mock scores every chunk before filtering, so a
// matching doc is never silently dropped just because higher-scoring
// non-matching docs would have filled the maxResults window first.

describe('metadata filter completeness', () => {
	test('filter returns all matching docs even when they rank below higher-scoring non-matching docs', async () => {
		const src = freshDir('_filter-completeness');
		mkdirSync(join(src, 'target'), { recursive: true });
		mkdirSync(join(src, 'noise'), { recursive: true });

		// 200 noise docs that strongly match "apple" (high TF-IDF score).
		for (let i = 0; i < 200; i++) {
			writeFileSync(
				join(src, 'noise', `n${i}.md`),
				'apple apple apple apple apple fruit orchard harvest season picking baskets cider juice.',
			);
		}
		// 5 target docs in folder=target that mention "apple" with lower density.
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
});

// ── Load recovery after a failed load ────────────────────────────────────────
//
// A failed load must not permanently poison the instance: the internal
// loadPromise is reset on failure so a later retrieve() can succeed once the
// underlying problem (e.g. a missing source folder) is resolved.

describe('load recovery after failed load', () => {
	test('instance recovers after the source folder is created following an initial failure', async () => {
		const srcName = '_error-recovery-src';
		cleanupDirs(srcName);

		const kb = new KnowledgeBase({ id: 'app' }, 'recover', { source: srcName });
		await assert.rejects(
			() => kb.retrieve('test query'),
			(err: Error) => {
				assert.strictEqual(err.name, KnowledgeBaseErrors.InvalidSource);
				return true;
			},
			'First call should fail because the source folder does not exist',
		);

		const src = freshDir(srcName);
		writeFileSync(
			join(src, 'doc.md'),
			'This document contains information about recovery testing and transient failures in distributed systems.',
		);

		try {
			const results = await kb.retrieve('recovery testing transient failures');
			assert.ok(
				results.length > 0,
				'Instance should recover after the source folder is created — loadPromise must not be permanently poisoned',
			);
		} finally {
			cleanupDirs(srcName);
		}
	});
});

// ── Chunking configuration ──────────────────────────────────────────────────
//
// The 'fixed' chunking strategy must be honored: a small chunkSize produces
// smaller chunks than the default 'semantic' strategy, which returns a
// blank-line-free document as a single oversized chunk.

describe('chunking configuration', () => {
	test('fixed chunking with a small chunkSize produces smaller chunks than the default', async () => {
		const src = freshDir('_chunking-fixed');
		// Single large paragraph (no blank lines) — about 500 words.
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

	test('negative / over-range chunkOverlap does not drop words (clamp behavior)', async () => {
		const srcName = '_overlap-clamp';
		const src = freshDir(srcName);
		// 200 words with a unique sentinel at index 120. A negative overlap in the
		// unclamped code pushes `step` past chunkSize (100), so the window holding
		// the sentinel (indices 100–199) is skipped entirely and the word vanishes
		// from the index. Clamping the overlap to >= 0 keeps every word covered.
		const parts: string[] = [];
		for (let i = 0; i < 200; i++) {
			parts.push(i === 120 ? 'zzsentinelword' : `filler${i}`);
		}
		writeFileSync(join(src, 'doc.md'), parts.join(' '));

		try {
			const kb = new KnowledgeBase({ id: 'app' }, 'clampneg', {
				source: srcName,
				chunking: { strategy: 'fixed', chunkSize: 100, chunkOverlap: -50 },
			});
			const results = await kb.retrieve('zzsentinelword');
			assert.ok(
				results.length > 0,
				'A negative chunkOverlap must not drop the middle window — every word stays indexed after clamping',
			);
			assert.ok(
				results[0].text.includes('zzsentinelword'),
				'the sentinel word in the would-be-skipped window should still be retrievable',
			);
		} finally {
			cleanupDirs(srcName);
		}
	});
});

// ── Unicode / multilingual retrieval ─────────────────────────────────────────
//
// The TF-IDF tokenizer is Unicode-aware (accent folding plus CJK bigrams). This
// end-to-end test proves non-ASCII content survives the file → chunk → index →
// retrieve pipeline. Accent-folding specifics are unit-tested in tfidf.test.ts.

describe('unicode / multilingual retrieval', () => {
	test('CJK content is searchable end-to-end', async () => {
		const src = freshDir('_unicode-cjk');
		writeFileSync(
			join(src, 'doc.md'),
			'機械学習のアルゴリズムはデータ処理を効率化します。人工知能は未来の技術です。',
		);

		try {
			const kb = new KnowledgeBase({ id: 'app' }, 'uni-cjk', { source: '_unicode-cjk' });
			const results = await kb.retrieve('機械学習 人工知能');
			assert.ok(
				results.length > 0,
				'CJK query should find CJK document content — tokenizer must not strip non-ASCII characters entirely',
			);
		} finally {
			cleanupDirs('_unicode-cjk');
		}
	});
});

// ── Cleanup after all tests ────────────────────────────────────────────────
test('cleanup', () => { cleanup(); });
