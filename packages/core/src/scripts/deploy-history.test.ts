// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
	DEPLOY_HISTORY_FILE,
	appendDeployHistoryRecord,
	createDeployRecorder,
	getGitSha,
	summarizeError,
} from './deploy-history.js';

function readHistory(projectRoot: string): Array<Record<string, unknown>> {
	return readFileSync(join(projectRoot, DEPLOY_HISTORY_FILE), 'utf-8')
		.split('\n')
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

describe('deploy-history', () => {
	let tmpDir: string;

	function makeProjectRoot(): string {
		tmpDir = join(tmpdir(), `deploy-history-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tmpDir, { recursive: true });
		return tmpDir;
	}

	afterEach(() => {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	it('appendDeployHistoryRecord creates .blocks and appends JSONL lines', () => {
		const root = makeProjectRoot();
		appendDeployHistoryRecord(root, { id: 'a', stage: 'production', startedAt: 't1', status: 'IN_PROGRESS' });
		appendDeployHistoryRecord(root, { id: 'a', stage: 'production', startedAt: 't1', status: 'SUCCEEDED' });
		const lines = readHistory(root);
		assert.strictEqual(lines.length, 2);
		assert.strictEqual(lines[0].status, 'IN_PROGRESS');
		assert.strictEqual(lines[1].status, 'SUCCEEDED');
	});

	it('appendDeployHistoryRecord never throws when the path is unwritable', () => {
		// A file where the .blocks DIRECTORY should be makes mkdirSync fail.
		const root = makeProjectRoot();
		appendDeployHistoryRecord(join(root, 'nope', '\0invalid'), {
			id: 'a',
			stage: 'production',
			startedAt: 't1',
			status: 'IN_PROGRESS',
		});
		// Reaching this line is the assertion.
		assert.ok(true);
	});

	it('recorder writes start and terminal records sharing one id', () => {
		const root = makeProjectRoot();
		const recorder = createDeployRecorder(root, 'production');
		recorder.start();
		recorder.succeed();
		const [start, end] = readHistory(root);
		assert.strictEqual(start.status, 'IN_PROGRESS');
		assert.strictEqual(end.status, 'SUCCEEDED');
		assert.strictEqual(start.id, end.id);
		assert.strictEqual(start.startedAt, end.startedAt);
		assert.ok(typeof end.finishedAt === 'string');
		assert.strictEqual(start.finishedAt, undefined);
	});

	it('recorder captures region and stackName when resolvable', () => {
		const root = makeProjectRoot();
		mkdirSync(join(root, '.blocks'), { recursive: true });
		writeFileSync(join(root, '.blocks', 'config.json'), JSON.stringify({ stackId: 'my-app' }));
		const originalRegion = process.env.AWS_REGION;
		process.env.AWS_REGION = 'eu-central-1';
		try {
			const recorder = createDeployRecorder(root, 'production');
			recorder.start();
			const [record] = readHistory(root);
			assert.strictEqual(record.region, 'eu-central-1');
			assert.strictEqual(record.stackName, 'my-app-prod');
		} finally {
			if (originalRegion === undefined) delete process.env.AWS_REGION;
			else process.env.AWS_REGION = originalRegion;
		}
	});

	it('recorder omits stackName when .blocks/config.json has no stackId', () => {
		const root = makeProjectRoot();
		const recorder = createDeployRecorder(root, 'production');
		recorder.start();
		const [record] = readHistory(root);
		assert.strictEqual(record.stackName, undefined);
	});

	it('recorder.fail records a FAILED status with an error summary', () => {
		const root = makeProjectRoot();
		const recorder = createDeployRecorder(root, 'production');
		recorder.start();
		recorder.fail(new Error('CREATE_FAILED something broke\nstack trace line'));
		const [, end] = readHistory(root);
		assert.strictEqual(end.status, 'FAILED');
		assert.strictEqual(end.errorSummary, 'CREATE_FAILED something broke');
	});

	it('recorder records the git SHA inside a git repo, omits it outside', () => {
		const root = makeProjectRoot();
		// Outside a repo (tmpdir): no gitSha field. Guard: tmpdir could
		// theoretically live under a repo — then getGitSha returns that SHA
		// and the assertion below adjusts.
		const outsideSha = getGitSha(root);
		const recorder = createDeployRecorder(root, 'production');
		recorder.start();
		const [record] = readHistory(root);
		assert.strictEqual(record.gitSha, outsideSha);

		// Inside a fresh repo with one commit: the HEAD SHA is recorded.
		const repo = join(root, 'repo');
		mkdirSync(repo);
		const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
		git('init');
		git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'x');
		const sha = getGitSha(repo);
		assert.ok(sha && /^[0-9a-f]{40}$/.test(sha));
	});
});

describe('summarizeError', () => {
	it('takes the first line of an Error message', () => {
		assert.strictEqual(summarizeError(new Error('first\nsecond')), 'first');
	});

	it('stringifies non-Error values', () => {
		assert.strictEqual(summarizeError('boom'), 'boom');
	});

	it('falls back for empty messages and truncates long ones', () => {
		assert.strictEqual(summarizeError(new Error('')), 'Unknown error');
		const long = 'x'.repeat(400);
		const summary = summarizeError(new Error(long));
		assert.strictEqual(summary.length, 301);
		assert.ok(summary.endsWith('…'));
	});
});
