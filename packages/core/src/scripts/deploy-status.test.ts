// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	formatDeployStatus,
	parseDeployStatus,
	readDeployStatus,
	runDeployStatusCli,
	runDeployWaitCli,
} from './deploy-status.js';
import { formatDeploySignal } from './deploy-stream.js';
import { BLOCKS_DEPLOY_FAILED_LINE } from '../common/constants.js';

// A realistic streamed deploy log tail, ending in the real success line the
// producer emits, so the parser is exercised against the exact string shape
// `formatDeploySignal` writes rather than a hand-typed approximation.
const SUCCESS_LOG =
	'🏗️  Preparing deployment...\n' +
	'🚀 Deploying to AWS...\n' +
	'MyStack | CREATE_COMPLETE | AWS::CloudFront::Distribution | HostingDistribution\n' +
	'\n✅ Deployment complete!\n' +
	'\n📡 API URL: https://api.example.com\n' +
	'🌐 Frontend URL: https://app.cloudfront.net\n' +
	`\n${formatDeploySignal('https://api.example.com', 'https://app.cloudfront.net')}\n`;

const FAILED_LOG =
	'🏗️  Preparing deployment...\n' +
	'🚀 Deploying to AWS...\n' +
	'MyStack | CREATE_FAILED | AWS::DynamoDB::Table | NotesTable\n' +
	`\n${BLOCKS_DEPLOY_FAILED_LINE}\n`;

describe('parseDeployStatus — turning a deploy log into a status', () => {
	it('reports running when neither terminal line is present', () => {
		assert.deepStrictEqual(parseDeployStatus('🚀 Deploying to AWS...\nCREATE_IN_PROGRESS ...'), {
			state: 'running',
		});
	});

	it('reports running for empty log text', () => {
		assert.deepStrictEqual(parseDeployStatus(''), { state: 'running' });
	});

	it('extracts url and api from the success signal', () => {
		assert.deepStrictEqual(parseDeployStatus(SUCCESS_LOG), {
			state: 'deployed',
			url: 'https://app.cloudfront.net',
			api: 'https://api.example.com',
		});
	});

	it('omits url for a backend-only (no-hosting) deploy', () => {
		const log = `done\n${formatDeploySignal('https://api.example.com')}\n`;
		assert.deepStrictEqual(parseDeployStatus(log), {
			state: 'deployed',
			api: 'https://api.example.com',
		});
	});

	it('reads deployed from a --wait-live liveness-unconfirmed log', () => {
		// When `--wait-live` cannot confirm the new build is live, the deploy
		// still SUCCEEDED, so deploy.ts emits the BLOCKS_DEPLOYED signal after a
		// ⚠️ warning (and exits non-zero only in the foreground). The log reader
		// must key off that terminal line and report `deployed` — otherwise
		// `deploy:wait` would poll to its cap on a deploy that is actually done.
		const livenessUnconfirmedLog =
			'🚀 Deploying to AWS...\n' +
			'\n⚠️  Could not confirm the new build is live after 180s (90 attempts). ' +
			'The deploy itself SUCCEEDED, but CloudFront may still be serving the previous build.\n' +
			'\n📡 API URL: https://api.example.com\n' +
			'🌐 Frontend URL: https://app.cloudfront.net\n' +
			`\n${formatDeploySignal('https://api.example.com', 'https://app.cloudfront.net')}\n`;
		assert.deepStrictEqual(parseDeployStatus(livenessUnconfirmedLog), {
			state: 'deployed',
			url: 'https://app.cloudfront.net',
			api: 'https://api.example.com',
		});
	});

	it('reports failed when the failure banner is the only terminal line', () => {
		assert.deepStrictEqual(parseDeployStatus(FAILED_LOG), { state: 'failed' });
	});

	it('takes the LAST terminal line so a re-run supersedes an earlier failure', () => {
		const reran = FAILED_LOG + SUCCESS_LOG;
		assert.deepStrictEqual(parseDeployStatus(reran), {
			state: 'deployed',
			url: 'https://app.cloudfront.net',
			api: 'https://api.example.com',
		});
	});

	it('takes the LAST terminal line so a later failure supersedes an earlier success', () => {
		const succeededThenFailed = SUCCESS_LOG + FAILED_LOG;
		assert.deepStrictEqual(parseDeployStatus(succeededThenFailed), { state: 'failed' });
	});

	it('does not treat prose that merely mentions the prefix as a success', () => {
		// A line can name the token without being the signal (e.g. a doc echo);
		// without an api= token it is not a completion.
		assert.deepStrictEqual(parseDeployStatus('note: look for the BLOCKS_DEPLOYED line\n'), {
			state: 'running',
		});
	});

	it('does not treat prose that merely quotes the failure banner as failed', () => {
		// Symmetric to the success prose-guard: the banner is anchored at the
		// (trimmed) line start, so a CDK/app log that echoes the sentence
		// mid-line is not misread as a terminal failure.
		const prose = 'hint: on error the deploy prints "❌ Deployment failed." to the log\n';
		assert.deepStrictEqual(parseDeployStatus(prose), { state: 'running' });
	});

	it('still reports failed when a spinner/timestamp fragment leads the banner line', () => {
		// trimStart (not an exact match) tolerates a leading fragment, so a real
		// terminal banner behind indentation is still detected.
		const withFragment = '  ❌ Deployment failed.\n';
		assert.deepStrictEqual(parseDeployStatus(withFragment), { state: 'failed' });
	});
});

describe('formatDeployStatus — the greppable one-liner', () => {
	it('renders a deployed status with both urls', () => {
		assert.strictEqual(
			formatDeployStatus({ state: 'deployed', url: 'https://u', api: 'https://a' }),
			'✅ deployed url=https://u api=https://a',
		);
	});
	it('renders a backend-only deployed status without url', () => {
		assert.strictEqual(formatDeployStatus({ state: 'deployed', api: 'https://a' }), '✅ deployed api=https://a');
	});
	it('renders failed and running', () => {
		assert.strictEqual(formatDeployStatus({ state: 'failed' }), '❌ failed');
		assert.strictEqual(formatDeployStatus({ state: 'running' }), '⏳ running');
	});
});

describe('readDeployStatus — reading the log file', () => {
	it('returns running for a log file that does not exist', () => {
		assert.deepStrictEqual(readDeployStatus(join(tmpdir(), 'definitely-absent-deploy.log')), {
			state: 'running',
		});
	});

	it('reads a success log from disk', () => {
		const dir = mkdtempSync(join(tmpdir(), 'deploy-status-'));
		try {
			const logPath = join(dir, 'deploy.log');
			writeFileSync(logPath, SUCCESS_LOG);
			assert.deepStrictEqual(readDeployStatus(logPath), {
				state: 'deployed',
				url: 'https://app.cloudfront.net',
				api: 'https://api.example.com',
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('runDeployStatusCli — one-shot status with a state-encoding exit code', () => {
	function captureStatus(logText: string | null): { out: string; code: number } {
		const dir = mkdtempSync(join(tmpdir(), 'deploy-status-'));
		try {
			const logPath = join(dir, 'deploy.log');
			if (logText !== null) writeFileSync(logPath, logText);
			let out = '';
			const code = runDeployStatusCli({ logPath, stdout: { write: (c: string) => (out += c) } });
			return { out, code };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it('exits 0 and prints the urls when deployed', () => {
		const { out, code } = captureStatus(SUCCESS_LOG);
		assert.strictEqual(code, 0);
		assert.match(out, /✅ deployed url=https:\/\/app\.cloudfront\.net api=https:\/\/api\.example\.com/);
	});

	it('exits 1 when failed', () => {
		const { out, code } = captureStatus(FAILED_LOG);
		assert.strictEqual(code, 1);
		assert.match(out, /❌ failed/);
	});

	it('exits 2 while still running (no terminal line)', () => {
		const { out, code } = captureStatus('CREATE_IN_PROGRESS ...\n');
		assert.strictEqual(code, 2);
		assert.match(out, /⏳ running/);
	});

	it('exits 2 when the log does not exist yet', () => {
		const { code } = captureStatus(null);
		assert.strictEqual(code, 2);
	});
});

describe('runDeployWaitCli — block until a terminal line appears', () => {
	it('returns 0 immediately when the log is already deployed', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'deploy-status-'));
		try {
			const logPath = join(dir, 'deploy.log');
			writeFileSync(logPath, SUCCESS_LOG);
			let out = '';
			const code = await runDeployWaitCli({
				logPath,
				stdout: { write: (c: string) => (out += c) },
				sleep: async () => {},
			});
			assert.strictEqual(code, 0);
			assert.match(out, /✅ deployed/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('polls until the log transitions from running to deployed', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'deploy-status-'));
		try {
			const logPath = join(dir, 'deploy.log');
			writeFileSync(logPath, 'CREATE_IN_PROGRESS ...\n');
			let reads = 0;
			// On the 3rd poll gap, the backgrounded deploy finishes and writes the
			// success line — the wait should then observe it and return 0.
			const code = await runDeployWaitCli({
				logPath,
				stdout: { write: () => {} },
				sleep: async () => {
					reads += 1;
					if (reads === 3) writeFileSync(logPath, SUCCESS_LOG);
				},
			});
			assert.strictEqual(code, 0);
			assert.ok(reads >= 3, 'polled until the terminal line appeared');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('returns 1 when the deploy fails', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'deploy-status-'));
		try {
			const logPath = join(dir, 'deploy.log');
			writeFileSync(logPath, FAILED_LOG);
			const code = await runDeployWaitCli({ logPath, stdout: { write: () => {} }, sleep: async () => {} });
			assert.strictEqual(code, 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('returns 2 (timed out) when the deadline passes with no terminal line', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'deploy-status-'));
		try {
			const logPath = join(dir, 'deploy.log');
			writeFileSync(logPath, 'CREATE_IN_PROGRESS ...\n');
			// A clock that jumps past the timeout on the first poll gap.
			let t = 0;
			let out = '';
			const code = await runDeployWaitCli({
				logPath,
				stdout: { write: (c: string) => (out += c) },
				timeoutMs: 1000,
				now: () => t,
				sleep: async () => {
					t += 2000;
				},
			});
			assert.strictEqual(code, 2);
			assert.match(out, /still running/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
