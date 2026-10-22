// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Tests for scripts/ci/e2e-cleanup.mjs. The cleanup cases run the real CDK CLI
// against a local fake of the CloudFormation and STS endpoints, with a live
// process holding the cdk.out lock the way a cancelled `cdk deploy` does.
//
// Run: node --test scripts/ci/e2e-cleanup.test.mjs

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/ci/e2e-cleanup.mjs');
const CDK = join(ROOT, 'node_modules/.bin/cdk');
const WORKFLOWS = readdirSync(join(ROOT, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f));

describe('findOrphans', () => {
	const procs = [
		{ pid: 1, ppid: 0 },
		{ pid: 10, ppid: 1, trackingId: 'job' }, // runner worker
		{ pid: 11, ppid: 10, trackingId: 'job' }, // the cleanup step's shell
		{ pid: 12, ppid: 11, trackingId: 'job' }, // this script
		{ pid: 13, ppid: 12, trackingId: 'job' }, // a child of this script (ps)
		{ pid: 14, ppid: 11, trackingId: 'job' }, // started by the cleanup step too (| tee)
		{ pid: 20, ppid: 1, trackingId: 'job' }, // the cancelled step's npm, reparented
		{ pid: 21, ppid: 20, trackingId: 'job' }, // ... and its cdk
		{ pid: 30, ppid: 1, trackingId: 'other' }, // another job's process
		{ pid: 31, ppid: 1 }, // a system process
	];

	it('returns the processes of this job outside its own ancestry', async () => {
		const { findOrphans } = await import('./e2e-cleanup.mjs');
		assert.deepEqual(findOrphans(procs, { selfPid: 12, trackingId: 'job' }), [20, 21]);
	});

	it('returns nothing without a tracking id', async () => {
		const { findOrphans } = await import('./e2e-cleanup.mjs');
		assert.deepEqual(findOrphans(procs, { selfPid: 12, trackingId: undefined }), []);
	});

	it('returns nothing when this process is not in the listing', async () => {
		const { findOrphans } = await import('./e2e-cleanup.mjs');
		assert.deepEqual(findOrphans(procs, { selfPid: 99, trackingId: 'job' }), []);
	});

	it('keeps the ancestry when the parent is not a step shell', async () => {
		const { findOrphans } = await import('./e2e-cleanup.mjs');
		const runnerParent = [
			{ pid: 10, ppid: 1 }, // runner worker, without the id
			{ pid: 12, ppid: 10, trackingId: 'job' }, // this script
			{ pid: 20, ppid: 10, trackingId: 'job' }, // an orphan reparented to the runner
		];
		assert.deepEqual(findOrphans(runnerParent, { selfPid: 12, trackingId: 'job' }), [20]);
	});
});

describe('parsePsLines', () => {
	it('reads pid, ppid and the tracking id from macOS ps -E output', async () => {
		const { parsePsLines } = await import('./e2e-cleanup.mjs');
		const text = [
			'    1     0 /sbin/launchd',
			'  812   640 node /w/node_modules/.bin/cdk deploy --all PATH=/usr/bin RUNNER_TRACKING_ID=github_abc HOME=/Users/runner',
			'  900     1 ',
		].join('\n');
		assert.deepEqual(parsePsLines(text), [
			{ pid: 1, ppid: 0, trackingId: undefined },
			{ pid: 812, ppid: 640, trackingId: 'github_abc' },
			{ pid: 900, ppid: 1, trackingId: undefined },
		]);
	});
});

describe('always() cleanup steps', () => {
	// Every command line of an always()/cancelled()/failure() step, in any workflow, that tears a stack down.
	const teardownLines = WORKFLOWS.flatMap((file) => {
		const wf = parse(readFileSync(join(ROOT, '.github/workflows', file), 'utf8'));
		return Object.entries(wf.jobs).flatMap(([job, def]) =>
			(def.steps ?? [])
				.map((s, index) => ({ ...s, index }))
				.filter((s) => /always\(\)|cancelled\(\)|failure\(\)/.test(String(s.if ?? '')) && s.run)
				.flatMap((s) =>
					s.run
						.split('\n')
						.filter((l) => /destroy|sandbox:delete/.test(l) && !/^\s*#/.test(l))
						.map((line) => ({
							where: `${file} ${job}`,
							line: line.trim(),
							if: String(s.if),
							steps: def.steps,
							index: s.index,
						})),
				),
		);
	});

	it('finds the teardown steps of the hosting, telemetry, amplify and native jobs', () => {
		assert.ok(teardownLines.length >= 8, JSON.stringify(teardownLines, null, 2));
	});

	it('run only once the job has AWS credentials', () => {
		for (const { where, if: cond, steps, index } of teardownLines) {
			assert.equal(cond, "always() && steps.aws-creds.outcome == 'success'", where);
			const creds = steps.findIndex((s) => /e2e-aws-credentials|configure-aws-credentials/.test(s.uses ?? ''));
			assert.ok(creds >= 0 && creds < index, `${where}: credentials step must come before the cleanup`);
			assert.equal(steps[creds].id, 'aws-creds', `${where}: the first credentials step must have id aws-creds`);
		}
	});

	it('run through e2e-cleanup.mjs, without || true', () => {
		for (const { where, line } of teardownLines) {
			assert.match(line, /scripts\/ci\/e2e-cleanup\.mjs"? -- /, `${where}: ${line}`);
			assert.doesNotMatch(line, /\|\| *true/, `${where}: ${line}`);
		}
	});
});

describe('cleanup while a cancelled step still holds the cdk.out lock', { skip: process.platform === 'win32' }, () => {
	let server;
	let endpoint;
	let deleted = [];

	// Answers the four calls `cdk destroy` makes: GetCallerIdentity,
	// DescribeStacks, DeleteStack, DescribeStackEvents.
	before(async () => {
		server = createServer((req, res) => {
			let body = '';
			req.on('data', (c) => {
				body += c;
			});
			req.on('end', () => {
				const p = new URLSearchParams(body);
				const name = p.get('StackName') ?? '';
				const cfn = 'xmlns="http://cloudformation.amazonaws.com/doc/2010-05-15/"';
				res.setHeader('content-type', 'text/xml');
				switch (p.get('Action')) {
					case 'GetCallerIdentity':
						return res.end(
							'<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult>' +
								'<Arn>arn:aws:iam::111111111111:user/test</Arn><UserId>TEST</UserId><Account>111111111111</Account>' +
								'</GetCallerIdentityResult></GetCallerIdentityResponse>',
						);
					case 'DescribeStacks':
						if (deleted.length > 0) {
							res.statusCode = 400;
							return res.end(
								`<ErrorResponse ${cfn}><Error><Type>Sender</Type><Code>ValidationError</Code>` +
									`<Message>Stack with id ${name} does not exist</Message></Error></ErrorResponse>`,
							);
						}
						return res.end(
							`<DescribeStacksResponse ${cfn}><DescribeStacksResult><Stacks><member><StackName>${name}</StackName>` +
								`<StackId>arn:aws:cloudformation:us-east-1:111111111111:stack/${name}/1</StackId>` +
								'<StackStatus>CREATE_COMPLETE</StackStatus><CreationTime>2026-01-01T00:00:00Z</CreationTime>' +
								'</member></Stacks></DescribeStacksResult></DescribeStacksResponse>',
						);
					case 'DeleteStack':
						deleted.push(name);
						return res.end(`<DeleteStackResponse ${cfn}></DeleteStackResponse>`);
					case 'DescribeStackEvents':
						return res.end(
							`<DescribeStackEventsResponse ${cfn}><DescribeStackEventsResult><StackEvents></StackEvents>` +
								'</DescribeStackEventsResult></DescribeStackEventsResponse>',
						);
					default:
						res.statusCode = 400;
						return res.end(
							`<ErrorResponse ${cfn}><Error><Code>InvalidAction</Code></Error></ErrorResponse>`,
						);
				}
			});
		});
		await new Promise((r) => server.listen(0, '127.0.0.1', r));
		endpoint = `http://127.0.0.1:${server.address().port}`;
	});

	after(() => server.close());

	/**
	 * A CDK app dir whose cdk.out has a read lock held by a live process with
	 * tracking id `trackingId`, as a cancelled `cdk deploy` leaves it.
	 */
	function setup(trackingId, holderCode = 'setInterval(() => {}, 1e6)') {
		deleted = [];
		const dir = mkdtempSync(join(tmpdir(), 'e2e-cleanup-'));
		const cdkLib = join(ROOT, 'node_modules/aws-cdk-lib/index.js');
		writeFileSync(
			join(dir, 'app.mjs'),
			`import { App, CfnResource, CliCredentialsStackSynthesizer, Stack } from ${JSON.stringify(cdkLib)};\n` +
				'const app = new App();\n' +
				"const stack = new Stack(app, 'CleanupTest', { synthesizer: new CliCredentialsStackSynthesizer() });\n" +
				"new CfnResource(stack, 'Handle', { type: 'AWS::CloudFormation::WaitConditionHandle' });\n" +
				'app.synth();\n',
		);
		// Started from a shell that exits at once, so the holder is reparented
		// like the processes of a cancelled step.
		const r = spawnSync('bash', ['-c', `'${process.execPath}' -e '${holderCode}' >/dev/null 2>&1 & echo $!`], {
			env: { ...process.env, RUNNER_TRACKING_ID: trackingId },
			encoding: 'utf8',
		});
		const holder = { pid: Number(r.stdout.trim()) };
		assert.ok(holder.pid > 0, r.stderr);
		mkdirSync(join(dir, 'cdk.out'));
		writeFileSync(join(dir, 'cdk.out', `read.${holder.pid}.1.lock`), String(holder.pid));
		const cleanup = () => {
			try {
				process.kill(holder.pid, 'SIGKILL');
			} catch {
				// stopped by the script under test
			}
			rmSync(dir, { recursive: true, force: true });
		};
		return { dir, holder, cleanup };
	}

	// Async: the fake endpoint runs in this process, so it must keep serving.
	function run(dir, cmd, args, trackingId) {
		const child = spawn(cmd, args, {
			cwd: dir,
			env: {
				...process.env,
				RUNNER_TRACKING_ID: trackingId,
				AWS_ENDPOINT_URL: endpoint,
				AWS_ACCESS_KEY_ID: 'AKIDTEST',
				AWS_SECRET_ACCESS_KEY: 'test',
				AWS_SESSION_TOKEN: '',
				AWS_PROFILE: '',
				AWS_REGION: 'us-east-1',
				AWS_EC2_METADATA_DISABLED: 'true',
				CDK_DISABLE_VERSION_CHECK: '1',
				CDK_DISABLE_CLI_TELEMETRY: '1',
				GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
			},
		});
		let output = '';
		child.stdout.on('data', (c) => {
			output += c;
		});
		child.stderr.on('data', (c) => {
			output += c;
		});
		return new Promise((resolve) => child.on('close', (status) => resolve({ status, output })));
	}

	const destroy = [CDK, 'destroy', '--force', '--app', 'node app.mjs'];

	it('the plain `|| true` step passes without issuing DeleteStack', async () => {
		const id = `test-${process.pid}-a`;
		const { dir, cleanup } = setup(id);
		try {
			const r = await run(dir, 'bash', ['-c', `${destroy.map((a) => `'${a}'`).join(' ')} || true`], id);
			assert.equal(r.status, 0);
			assert.match(r.output, /\block\b|currently (reading|synthing)/i);
			assert.deepEqual(deleted, []);
		} finally {
			cleanup();
		}
	});

	it('e2e-cleanup.mjs stops the lock holder and the destroy issues DeleteStack', async () => {
		const id = `test-${process.pid}-b`;
		const { dir, holder, cleanup } = setup(id);
		try {
			const r = await run(dir, process.execPath, [SCRIPT, '--', ...destroy], id);
			assert.equal(r.status, 0, r.output);
			assert.doesNotMatch(r.output, /currently (reading|synthing)|E2E cleanup failed/);
			assert.equal(deleted.length, 1, r.output);
			assert.match(deleted[0], /CleanupTest/);
			assert.throws(() => process.kill(holder.pid, 0), /ESRCH/);
		} finally {
			cleanup();
		}
	});

	it('e2e-cleanup.mjs SIGKILLs a holder that ignores SIGTERM', async () => {
		const id = `test-${process.pid}-e`;
		const { dir, holder, cleanup } = setup(id, 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1e6)');
		try {
			const r = await run(dir, process.execPath, [SCRIPT, '--', 'true'], id);
			assert.equal(r.status, 0, r.output);
			assert.match(r.output, new RegExp(`SIGKILL: ${holder.pid}`));
			assert.doesNotMatch(r.output, /Still present/);
			assert.throws(() => process.kill(holder.pid, 0), /ESRCH/);
		} finally {
			cleanup();
		}
	});

	it('e2e-cleanup.mjs leaves processes of other jobs alone', async () => {
		const { dir, holder, cleanup } = setup(`test-${process.pid}-other`);
		try {
			const r = await run(dir, process.execPath, [SCRIPT, '--', 'true'], `test-${process.pid}-c`);
			assert.equal(r.status, 0, r.output);
			assert.doesNotMatch(r.output, /Stopping/);
			process.kill(holder.pid, 0); // still running
		} finally {
			cleanup();
		}
	});

	it('e2e-cleanup.mjs reports a failed destroy in an annotation and the step summary, and exits 0', async () => {
		const id = `test-${process.pid}-d`;
		const { dir, cleanup } = setup(id);
		try {
			const r = await run(dir, process.execPath, [SCRIPT, '--', 'bash', '-c', 'exit 3'], id);
			assert.equal(r.status, 0);
			assert.match(r.output, /^::warning title=E2E cleanup failed::'bash -c exit 3' exited with 3/m);
			assert.match(readFileSync(join(dir, 'summary.md'), 'utf8'), /### E2E cleanup failed/);
		} finally {
			cleanup();
		}
	});
});
