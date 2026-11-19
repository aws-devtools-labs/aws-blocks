// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Covers legacy mock-data carry-over into `.cdk-blocks/local/data`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { getMockDataDir, LEGACY_MOCK_DATA_DIR, MOCK_DATA_DIR, MockDataDirError } from './mock-data.js';

/** `getMockDataDir` only reads `fullId`, so a bare object is the whole contract. */
const scope = (fullId: string) => ({ fullId }) as unknown as Parameters<typeof getMockDataDir>[0];

describe('getMockDataDir', () => {
	let project: string;
	let cwd: string;

	beforeEach(() => {
		cwd = process.cwd();
		project = realpathSync(mkdtempSync(join(tmpdir(), 'mock-data-')));
		process.chdir(project);
	});

	afterEach(() => {
		process.chdir(cwd);
		try {
			chmodSync(project, 0o700);
		} catch {}
		rmSync(project, { recursive: true, force: true, maxRetries: 5 });
	});

	/** A populated pre-consolidation project: one per-block store, one shared file. */
	function seedLegacy(): void {
		mkdirSync(join(LEGACY_MOCK_DATA_DIR, 'app-todos'), { recursive: true });
		writeFileSync(join(LEGACY_MOCK_DATA_DIR, 'app-todos', 'store.json'), '{"t1":"buy milk"}');
		writeFileSync(join(LEGACY_MOCK_DATA_DIR, 'settings.json'), '{"app-token-secret":"s3cr3t"}');
	}

	void it('resolves under the consolidated folder', () => {
		assert.equal(getMockDataDir(scope('app-todos')), join(project, MOCK_DATA_DIR, 'app-todos'));
		assert.equal(getMockDataDir(scope('app-todos'), { root: true }), join(project, MOCK_DATA_DIR));
	});

	void it('carries a per-block store across with its contents intact, and leaves the original', () => {
		seedLegacy();
		const dir = getMockDataDir(scope('app-todos'));
		assert.equal(readFileSync(join(dir, 'store.json'), 'utf-8'), '{"t1":"buy milk"}');
		// Copy, not move: an older CLI in the same checkout still reads the old path.
		assert.ok(existsSync(join(LEGACY_MOCK_DATA_DIR, 'app-todos', 'store.json')));
	});

	void it('carries a shared root file across even after a per-block call ran first', () => {
		// The regression this exists for: a per-block call creates the data root as
		// a side effect of `recursive: true`, so a carry-over gated on "did I just
		// create this directory" skipped every shared file.
		seedLegacy();
		getMockDataDir(scope('app-todos'));
		const root = getMockDataDir(scope('app-todos'), { root: true });
		assert.equal(readFileSync(join(root, 'settings.json'), 'utf-8'), '{"app-token-secret":"s3cr3t"}');
	});

	void it('never replaces what is already in the new location', () => {
		seedLegacy();
		const root = getMockDataDir(scope('app-todos'), { root: true });
		writeFileSync(join(root, 'settings.json'), '{"keep":"me"}');
		assert.equal(
			readFileSync(join(getMockDataDir(scope('app-todos'), { root: true }), 'settings.json'), 'utf-8'),
			'{"keep":"me"}',
		);
	});

	void it('does not migrate another block on a root call', () => {
		// A root call copies the legacy root's FILES only. Its subdirectories are
		// other blocks' units and are carried over by their own call, so a block
		// that never runs is never migrated.
		seedLegacy();
		getMockDataDir(scope('app-other'), { root: true });
		assert.ok(!existsSync(join(MOCK_DATA_DIR, 'app-todos')));
	});

	void it('fails loudly, naming the path, when the directory cannot be created', () => {
		if (typeof process.getuid === 'function' && process.getuid() === 0) return;
		chmodSync(project, 0o500);
		assert.throws(
			() => getMockDataDir(scope('app-todos')),
			(error: unknown) => {
				assert.ok(error instanceof MockDataDirError);
				assert.match(error.message, /\.cdk-blocks[/\\]local[/\\]data/);
				return true;
			},
		);
	});

	void it('fails loudly on a root call too, when the directory cannot be created', () => {
		if (typeof process.getuid === 'function' && process.getuid() === 0) return;
		chmodSync(project, 0o500);
		assert.throws(
			() => getMockDataDir(scope('app-todos'), { root: true }),
			(error: unknown) => {
				assert.ok(error instanceof MockDataDirError);
				assert.match(error.message, /\.cdk-blocks[/\\]local[/\\]data/);
				return true;
			},
		);
	});

	void it('is a no-op for a project that never had the old directory', () => {
		const dir = getMockDataDir(scope('app-todos'));
		assert.ok(existsSync(dir));
		assert.ok(!existsSync(LEGACY_MOCK_DATA_DIR));
	});
	// A delete is indistinguishable from "never carried": both leave the
	// destination missing. Copying whatever is missing therefore undid deletions
	// — a FileBucket object unlinked by `delete()` reappeared on the next call,
	// and every PGlite open restored the files Postgres had removed.
	void it('does not bring a deleted unit file back on the next call', () => {
		const legacyUnit = join(project, LEGACY_MOCK_DATA_DIR, 'app-todos');
		mkdirSync(legacyUnit, { recursive: true });
		writeFileSync(join(legacyUnit, 'store.json'), '{"1":{"title":"carried"}}');

		const dir = getMockDataDir(scope('app-todos'));
		const carried = join(dir, 'store.json');
		assert.ok(existsSync(carried), 'first call carries the unit over');

		rmSync(carried);
		getMockDataDir(scope('app-todos'));
		assert.ok(!existsSync(carried), 'a deleted file must stay deleted');
	});

	// A single shared record was a read-modify-write: concurrent first uses
	// overwrote each other, and an unrecorded unit was carried again later and
	// could restore data deleted in the new location. One marker file per unit has
	// no shared write, so every unit is recorded even when they start together.
	void it('records every unit when many first uses run at once', () => {
		const N = 16;
		for (let i = 0; i < N; i++) {
			const unit = join(project, LEGACY_MOCK_DATA_DIR, `u${i}`);
			mkdirSync(unit, { recursive: true });
			writeFileSync(join(unit, 'store.json'), `{"i":${i}}`);
		}
		const child = join(project, 'child.mjs');
		const moduleUrl = pathToFileURL(join(import.meta.dirname, 'mock-data.js')).href;
		writeFileSync(child, `import('${moduleUrl}').then((m) => m.getMockDataDir({ fullId: process.argv[2] }));\n`);

		const runs = Array.from({ length: N }, (_, i) =>
			spawnSync(process.execPath, [child, `u${i}`], { cwd: project, encoding: 'utf-8' }),
		);
		assert.deepStrictEqual(
			runs.filter((r) => r.status !== 0).map((r) => r.stderr),
			[],
		);

		const markers = readdirSync(join(project, '.cdk-blocks', 'local', '.carried-over.d')).filter((f) =>
			f.startsWith('unit.'),
		);
		assert.equal(markers.length, N, `recorded ${markers.length} of ${N}`);
	});

	void it('does not bring a deleted shared root file back on the next call', () => {
		mkdirSync(join(project, LEGACY_MOCK_DATA_DIR), { recursive: true });
		writeFileSync(join(project, LEGACY_MOCK_DATA_DIR, 'settings.json'), '{"a":1}');

		const root = getMockDataDir(scope('app-todos'), { root: true });
		const carried = join(root, 'settings.json');
		assert.ok(existsSync(carried), 'first root call carries the shared file over');

		rmSync(carried);
		getMockDataDir(scope('app-todos'), { root: true });
		assert.ok(!existsSync(carried), 'a deleted shared file must stay deleted');
	});
	// `check:data-ignored` writes the `*` marker itself and then asks git about it,
	// so on its own it only tests git's `.gitignore` semantics: it would still pass
	// if `markLocalIgnored()` stopped writing the marker. These two assert the real
	// call produces it, and that git attributes the data to it.
	void it('writes the self-ignoring marker so local data cannot be staged', () => {
		const dir = getMockDataDir(scope('app-todos'));
		const marker = join(project, '.cdk-blocks', 'local', '.gitignore');
		assert.ok(existsSync(marker), 'getMockDataDir must write .cdk-blocks/local/.gitignore');
		assert.equal(readFileSync(marker, 'utf-8').trim(), '*');
		assert.ok(dir.startsWith(join(project, '.cdk-blocks', 'local', 'data')));
	});

	void it('has git attribute the data to that marker, with no root rule present', () => {
		spawnSync('git', ['init', '-q'], { cwd: project });
		const dir = getMockDataDir(scope('app-todos'));
		writeFileSync(join(dir, 'store.json'), '{}');
		const probe = spawnSync('git', ['check-ignore', '-v', join(dir, 'store.json')], {
			cwd: project,
			encoding: 'utf-8',
		});
		assert.equal(probe.status, 0, 'the data must be ignored');
		assert.match(probe.stdout, /local[/\\]\.gitignore/, `attributed to: ${probe.stdout}`);
	});
});
