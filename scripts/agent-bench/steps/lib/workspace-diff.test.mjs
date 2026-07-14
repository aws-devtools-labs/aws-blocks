// Integration + unit tests for the LOC/files workspace-diff helper (workspace-diff.mjs). The
// begin/finish tests exercise REAL git against a REAL temp workspace (no mocks): scaffold → snapshot →
// mutate → diff. parseChurn is tested purely on captured git output.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { beginWorkspaceDiff, finishWorkspaceDiff, parseChurn } from './workspace-diff.mjs';

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

describe('parseChurn(numstat, namestat) — pure parser', () => {
	it('added files → loc_created + files_created; modified → loc_edited + files_edited', () => {
		const numstat = ['10\t0\tsrc/new.ts', '3\t2\tsrc/existing.ts'].join('\n');
		const namestat = ['A\tsrc/new.ts', 'M\tsrc/existing.ts'].join('\n');
		assert.deepEqual(parseChurn(numstat, namestat), {
			loc_created: 10,
			loc_edited: 5, // 3 added + 2 deleted on the modified file
			files_created: 1,
			files_edited: 1,
		});
	});
	it('deletions contribute nothing (not created, not edited)', () => {
		assert.deepEqual(parseChurn('0\t8\tsrc/gone.ts', 'D\tsrc/gone.ts'), {
			loc_created: 0,
			loc_edited: 0,
			files_created: 0,
			files_edited: 0,
		});
	});
	it('a rename (R) counts as an edit on the new path', () => {
		// -M rewrites the numstat path to the new name; name-status carries `R<score>\told\tnew`.
		const numstat = '2\t1\tsrc/renamed.ts';
		const namestat = 'R096\tsrc/old.ts\tsrc/renamed.ts';
		assert.deepEqual(parseChurn(numstat, namestat), {
			loc_created: 0,
			loc_edited: 3,
			files_created: 0,
			files_edited: 1,
		});
	});
	it('binary files (— added/deleted) count as a file but 0 lines', () => {
		assert.deepEqual(parseChurn('-\t-\tlogo.png', 'A\tlogo.png'), {
			loc_created: 0,
			loc_edited: 0,
			files_created: 1,
			files_edited: 0,
		});
	});
	it('empty output → all zeros', () => {
		assert.deepEqual(parseChurn('', ''), { loc_created: 0, loc_edited: 0, files_created: 0, files_edited: 0 });
	});
});

describe('begin/finishWorkspaceDiff — REAL git against a REAL workspace', { skip: !hasGit }, () => {
	let ws;
	before(() => {
		ws = mkdtempSync(join(tmpdir(), 'bench-ws-test-'));
		mkdirSync(join(ws, 'src'), { recursive: true });
		writeFileSync(join(ws, 'src', 'keep.ts'), 'line1\nline2\nline3\n');
		writeFileSync(join(ws, '.gitignore'), 'node_modules/\n');
		mkdirSync(join(ws, 'node_modules', 'dep'), { recursive: true });
		writeFileSync(join(ws, 'node_modules', 'dep', 'index.js'), 'module.exports = {};\n');
	});
	after(() => rmSync(ws, { recursive: true, force: true }));

	it('captures a snapshot then reports created + edited churn, ignoring node_modules', () => {
		const snap = beginWorkspaceDiff(ws);
		assert.ok(snap && snap.baseTree, 'snapshot must succeed with a base tree');

		// Agent mutations: add a new 2-line file, append a line to keep.ts, drop a node_modules file.
		writeFileSync(join(ws, 'src', 'added.ts'), 'a\nb\n');
		writeFileSync(join(ws, 'src', 'keep.ts'), 'line1\nline2\nline3\nline4\n'); // +1 line
		writeFileSync(join(ws, 'node_modules', 'dep', 'extra.js'), 'noise\n'); // must be ignored

		const churn = finishWorkspaceDiff(snap, ws);
		assert.equal(churn.files_created, 1, 'one new tracked file (added.ts)');
		assert.equal(churn.loc_created, 2, 'added.ts has 2 lines');
		assert.equal(churn.files_edited, 1, 'keep.ts modified');
		assert.equal(churn.loc_edited, 1, 'keep.ts +1 line, -0');
	});

	it('a null snapshot yields all-null churn (graceful degradation)', () => {
		assert.deepEqual(finishWorkspaceDiff(null, ws), {
			loc_created: null,
			loc_edited: null,
			files_created: null,
			files_edited: null,
		});
	});

	it('no changes since the snapshot → all zeros', () => {
		const snap = beginWorkspaceDiff(ws);
		assert.ok(snap);
		assert.deepEqual(finishWorkspaceDiff(snap, ws), {
			loc_created: 0,
			loc_edited: 0,
			files_created: 0,
			files_edited: 0,
		});
	});
});
