// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// `.blocks/config.json` holds the committed `stackId` next to the telemetry keys, so
// the telemetry writers must never drop it: not on a BOM, not on a file they can't
// parse, and not when several processes write at once.

import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { writeConfigTelemetry } from './config-writer.js';
import { getProjectId } from './identifiers.js';

const BOM = '\uFEFF';
const configWriterUrl = new URL('./config-writer.js', import.meta.url).href;
const identifiersUrl = new URL('./identifiers.js', import.meta.url).href;
const telemetryCliUrl = new URL('../scripts/telemetry.js', import.meta.url).href;

const UNPARSEABLE: ReadonlyArray<readonly [string, string]> = [
	['invalid JSON (trailing comma)', '{ "stackId": "my-app-1", }'],
	['a top-level array', '[1, 2]'],
	['a top-level null', 'null'],
	['an empty file', ''],
];

let app: string;
let configPath: string;
const originalCwd = process.cwd();

beforeEach(() => {
	app = mkdtempSync(join(tmpdir(), 'blocks-project-config-'));
	mkdirSync(join(app, '.blocks'));
	configPath = join(app, '.blocks', 'config.json');
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(app, { recursive: true, force: true });
});

function readJson(): Record<string, unknown> {
	return JSON.parse(readFileSync(configPath, 'utf-8'));
}

/** Run `code` (an ES module body) in a child node process, cwd = the app, HOME isolated. */
function runChild(code: string, env: Record<string, string> = {}) {
	return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
		cwd: app,
		encoding: 'utf-8',
		timeout: 20_000,
		env: {
			...process.env,
			HOME: app,
			USERPROFILE: app,
			AWS_BLOCKS_DISABLE_TELEMETRY: '',
			NODE_OPTIONS: '',
			...env,
		},
	});
}

void describe('writeConfigTelemetry keeps the rest of .blocks/config.json', () => {
	void it('reads a config saved with a UTF-8 BOM and keeps its stackId', () => {
		writeFileSync(configPath, `${BOM}{\n  "stackId": "my-app-1"\n}\n`);
		writeConfigTelemetry(configPath, false);
		assert.deepStrictEqual(readJson(), { stackId: 'my-app-1', telemetry: { enabled: false } });
	});

	for (const [label, content] of UNPARSEABLE) {
		void it(`throws and leaves the file untouched when it is ${label}`, () => {
			writeFileSync(configPath, content);
			assert.throws(() => writeConfigTelemetry(configPath, false), /could not be read.*left unchanged/s);
			assert.strictEqual(readFileSync(configPath, 'utf-8'), content);
		});
	}

	void it('preserves every other top-level and telemetry key', () => {
		writeFileSync(
			configPath,
			JSON.stringify({ stackId: 'my-app-1', custom: { a: [1] }, telemetry: { projectId: 'p-1' } }),
		);
		writeConfigTelemetry(configPath, true);
		assert.deepStrictEqual(readJson(), {
			stackId: 'my-app-1',
			custom: { a: [1] },
			telemetry: { projectId: 'p-1', enabled: true },
		});
	});

	void it('replaces the file atomically and leaves no temp file behind', () => {
		writeFileSync(configPath, '{"stackId":"my-app-1"}');
		writeConfigTelemetry(configPath, true);
		writeConfigTelemetry(configPath, false);
		assert.deepStrictEqual(readdirSync(join(app, '.blocks')), ['config.json']);
	});
});

void describe('getProjectId keeps the rest of .blocks/config.json', () => {
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

	void it('reads a config saved with a UTF-8 BOM, keeps its stackId and persists the id', () => {
		writeFileSync(configPath, `${BOM}{\n  "stackId": "my-app-1"\n}\n`);
		process.chdir(app);
		const id = getProjectId();
		assert.match(id, uuid);
		assert.deepStrictEqual(readJson(), { stackId: 'my-app-1', telemetry: { projectId: id } });
		assert.strictEqual(getProjectId(), id, 'the persisted id is reused');
	});

	void it('reads an existing projectId from a BOM config without rewriting it', () => {
		const content = `${BOM}{"stackId":"my-app-1","telemetry":{"projectId":"p-1"}}`;
		writeFileSync(configPath, content);
		process.chdir(app);
		assert.strictEqual(getProjectId(), 'p-1');
		assert.strictEqual(readFileSync(configPath, 'utf-8'), content);
	});

	for (const [label, content] of UNPARSEABLE) {
		void it(`returns a session id and does not rewrite a config that is ${label}`, () => {
			writeFileSync(configPath, content);
			process.chdir(app);
			assert.match(getProjectId(), uuid);
			assert.strictEqual(readFileSync(configPath, 'utf-8'), content);
		});
	}

	void it('preserves other keys when it adds the projectId', () => {
		writeFileSync(configPath, JSON.stringify({ stackId: 'my-app-1', other: true, telemetry: { enabled: true } }));
		process.chdir(app);
		const id = getProjectId();
		assert.deepStrictEqual(readJson(), {
			stackId: 'my-app-1',
			other: true,
			telemetry: { enabled: true, projectId: id },
		});
	});

	void it('says why it skipped the write under NODE_DEBUG=blocks-telemetry', () => {
		writeFileSync(configPath, '[1, 2]');
		const r = runChild(`import { getProjectId } from ${JSON.stringify(identifiersUrl)}; getProjectId();`, {
			NODE_DEBUG: 'blocks-telemetry',
		});
		assert.strictEqual(r.status, 0, r.stderr);
		assert.match(r.stderr, /not persisting the projectId/);
		assert.match(r.stderr, /not a JSON object/);
		assert.strictEqual(readFileSync(configPath, 'utf-8'), '[1, 2]');
	});
});

void describe('blocks-telemetry --enable/--disable on an unreadable project config', () => {
	for (const [label, content] of UNPARSEABLE) {
		void it(`fails with exit 1 and no success message when the config is ${label}`, () => {
			writeFileSync(configPath, content);
			const r = runChild(
				`import { telemetry } from ${JSON.stringify(telemetryCliUrl)}; await telemetry({ argv: ['node', 'blocks-telemetry', '--disable'] });`,
			);
			assert.strictEqual(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
			assert.match(r.stderr, /Failed to write config: .*config\.json could not be read/);
			assert.doesNotMatch(r.stdout, /Telemetry disabled/);
			assert.strictEqual(readFileSync(configPath, 'utf-8'), content);
		});
	}
});

interface ChildResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Start `code` (an ES module body) in a child node process, cwd = the app, HOME isolated. */
function startChild(code: string, env: Record<string, string> = {}) {
	const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
		cwd: app,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			HOME: app,
			USERPROFILE: app,
			AWS_BLOCKS_DISABLE_TELEMETRY: '',
			NODE_OPTIONS: '',
			...env,
		},
	});
	let stdout = '';
	let stderr = '';
	child.stdout.on('data', (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr.on('data', (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const done = new Promise<ChildResult>((resolve, reject) => {
		child.on('error', reject);
		child.on('close', (code) => resolve({ code, stdout, stderr }));
	});
	return { child, done };
}

const printProjectId = `import { getProjectId } from ${JSON.stringify(identifiersUrl)}; console.log(getProjectId());`;
const disableCli = `import { telemetry } from ${JSON.stringify(telemetryCliUrl)}; await telemetry({ argv: ['node', 'blocks-telemetry', '--disable'] });`;

function toggleCode(enabled: boolean): string {
	return `import { writeConfigTelemetry } from ${JSON.stringify(configWriterUrl)}; writeConfigTelemetry(${JSON.stringify(configPath)}, ${enabled});`;
}

/**
 * Poll `condition` until it holds. The other side is a separate process that signals
 * only through the file system, so there is no in-process event to await.
 */
async function waitUntil(condition: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
	for (const deadline = Date.now() + timeoutMs; !condition(); ) {
		assert.ok(Date.now() < deadline, message);
		await new Promise((resolve) => setImmediate(resolve));
	}
}

void describe('concurrent writers never lose stackId', () => {
	const PROCESSES = 12;
	const ROUNDS = 5;
	const WRITES_PER_PROCESS = 25;

	// Even writers toggle telemetry.enabled; odd writers also read (and, until one wins,
	// create) telemetry.projectId via getProjectId, so both write paths race each other.
	function writerCode(index: number): string {
		return index % 2 === 0
			? `import { writeConfigTelemetry } from ${JSON.stringify(configWriterUrl)};
for (let i = 0; i < ${WRITES_PER_PROCESS}; i++) writeConfigTelemetry(${JSON.stringify(configPath)}, i % 2 === 0);`
			: `import { getProjectId } from ${JSON.stringify(identifiersUrl)};
import { writeConfigTelemetry } from ${JSON.stringify(configWriterUrl)};
for (let i = 0; i < ${WRITES_PER_PROCESS}; i++) { getProjectId(); writeConfigTelemetry(${JSON.stringify(configPath)}, true); }`;
	}

	void it(`${PROCESSES} parallel processes x ${ROUNDS} rounds keep stackId and valid JSON`, {
		timeout: 120_000,
	}, async () => {
		const lost: number[] = [];
		for (let round = 0; round < ROUNDS; round++) {
			writeFileSync(configPath, JSON.stringify({ stackId: 'my-app-1', other: 'keep' }, null, 2));
			const results = await Promise.all(
				Array.from({ length: PROCESSES }, (_, i) => startChild(writerCode(i)).done),
			);
			for (const r of results) assert.strictEqual(r.code, 0, `a writer failed: ${r.stderr}`);
			const config = readJson();
			if (config.stackId !== 'my-app-1' || config.other !== 'keep') lost.push(round);
			const leftovers = readdirSync(join(app, '.blocks')).filter((f) => f !== 'config.json');
			assert.deepStrictEqual(leftovers, [], 'no temp or lock files left behind');
		}
		assert.deepStrictEqual(lost, [], `stackId/other lost in rounds ${lost.join(', ')} of ${ROUNDS}`);
	});
});

// Writers of different keys must not undo each other: the whole read-modify-write
// runs under `<config>.lock`. The `BLOCKS_TEST_CONFIG_LOCK_HOOKS` hooks run while the
// lock is held: `pause` stops a writer after its read, and `log` records every write
// in commit order.
void describe('the config lock serializes writers of different keys', () => {
	let hooks: string;

	beforeEach(() => {
		hooks = join(app, 'hooks');
		mkdirSync(hooks);
	});

	void it('a projectId writer paused mid-update cannot undo a concurrent --disable', {
		timeout: 30_000,
	}, async () => {
		writeFileSync(configPath, JSON.stringify({ stackId: 'my-app-1' }));
		writeFileSync(join(hooks, 'pause'), '');
		const writer = startChild(printProjectId, { BLOCKS_TEST_CONFIG_LOCK_HOOKS: hooks });
		await waitUntil(
			() => readdirSync(hooks).some((f) => f.startsWith('paused-')),
			'the projectId writer never paused inside its locked update',
		);
		// The writer has read the config and holds the lock. --disable must queue behind it:
		// wait until it either exits or shows up as a contender (its lock record temp file).
		const disable = startChild(disableCli);
		await waitUntil(
			() =>
				disable.child.exitCode !== null ||
				readdirSync(join(app, '.blocks')).some((f) => /\.lock\..+\.tmp$/.test(f)),
			'--disable neither finished nor contended for the lock',
		);
		const disableWaited = disable.child.exitCode === null;
		rmSync(join(hooks, 'pause'));
		const [w, d] = await Promise.all([writer.done, disable.done]);
		assert.strictEqual(w.code, 0, w.stderr);
		assert.strictEqual(d.code, 0, d.stderr);
		assert.match(d.stdout, /Telemetry disabled for this project/);
		assert.ok(disableWaited, '--disable finished while another writer held the config mid-update');
		assert.deepStrictEqual(readJson(), {
			stackId: 'my-app-1',
			telemetry: { projectId: w.stdout.trim(), enabled: false },
		});
	});

	const PROCESSES = 12;
	const ROUNDS = 20;

	void it(`${PROCESSES} parallel projectId writers and toggles x ${ROUNDS} rounds: the last committed toggle wins and the projectId never changes`, {
		timeout: 240_000,
	}, async () => {
		for (let round = 0; round < ROUNDS; round++) {
			writeFileSync(configPath, JSON.stringify({ stackId: 'my-app-1', other: 'keep' }, null, 2));
			rmSync(join(hooks, 'log'), { force: true });
			// Even children set telemetry.enabled once (alternating values); odd children record the projectId.
			const children = Array.from({ length: PROCESSES }, (_, i) => {
				const enabled = i % 4 === 0;
				const started = startChild(i % 2 === 0 ? toggleCode(enabled) : printProjectId, {
					BLOCKS_TEST_CONFIG_LOCK_HOOKS: hooks,
				});
				return { role: i % 2 === 0 ? ('toggle' as const) : ('projectId' as const), enabled, ...started };
			});
			const results = await Promise.all(children.map((c) => c.done));
			for (const r of results) assert.strictEqual(r.code, 0, `a writer failed: ${r.stderr}`);

			const roleByPid = new Map(children.map((c) => [c.child.pid, c]));
			const log: Array<{ pid: number; telemetry: { enabled?: boolean; projectId?: string } }> = readFileSync(
				join(hooks, 'log'),
				'utf-8',
			)
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line));
			const toggles = log.filter((entry) => roleByPid.get(entry.pid)?.role === 'toggle');
			assert.strictEqual(toggles.length, PROCESSES / 2, `round ${round}: every toggle committed once`);
			for (const entry of toggles) assert.strictEqual(entry.telemetry.enabled, roleByPid.get(entry.pid)?.enabled);

			const config = readJson();
			const telemetry = config.telemetry as { enabled?: boolean; projectId?: string };
			assert.strictEqual(config.stackId, 'my-app-1', `round ${round}: stackId`);
			assert.strictEqual(config.other, 'keep', `round ${round}: other key`);
			assert.strictEqual(
				telemetry.enabled,
				toggles.at(-1)?.telemetry.enabled,
				`round ${round}: last committed toggle wins`,
			);

			const firstWithId = log.findIndex((entry) => entry.telemetry.projectId);
			assert.ok(firstWithId >= 0, `round ${round}: a projectId was written`);
			const projectId = log[firstWithId].telemetry.projectId;
			for (const entry of log.slice(firstWithId)) {
				assert.strictEqual(
					entry.telemetry.projectId,
					projectId,
					`round ${round}: projectId lost or changed after it was written`,
				);
			}
			assert.strictEqual(telemetry.projectId, projectId);
			for (const [i, r] of results.entries()) {
				if (children[i].role === 'projectId')
					assert.strictEqual(r.stdout.trim(), projectId, `round ${round}: every caller got the persisted id`);
			}
			assert.deepStrictEqual(
				readdirSync(join(app, '.blocks')),
				['config.json'],
				'no temp or lock files left behind',
			);
		}
	});
});

void describe('the config lock: stale and live holders', () => {
	let lockPath: string;

	beforeEach(() => {
		lockPath = `${configPath}.lock`;
		writeFileSync(configPath, JSON.stringify({ stackId: 'my-app-1' }));
	});

	/** A pid that has exited. */
	function deadPid(): number {
		const exited = spawnSync(process.execPath, ['-e', '']);
		assert.ok(exited.pid);
		return exited.pid;
	}

	function lockRecord(pid: number, token: string, start: string | null = '1'): string {
		return JSON.stringify({ pid, start, host: hostname(), token });
	}

	void it('takes over a lock whose owner has exited', () => {
		writeFileSync(lockPath, lockRecord(deadPid(), 'dead-owner'));
		writeConfigTelemetry(configPath, false);
		assert.deepStrictEqual(readJson(), { stackId: 'my-app-1', telemetry: { enabled: false } });
		assert.deepStrictEqual(readdirSync(join(app, '.blocks')), ['config.json'], 'stale lock and reap file removed');
	});

	void it('takes over a stale lock whose reap file was left by a reaper that also exited', () => {
		writeFileSync(lockPath, lockRecord(deadPid(), 'dead-owner'));
		writeFileSync(`${lockPath}.reap-dead-owner`, lockRecord(deadPid(), 'dead-reaper'));
		writeConfigTelemetry(configPath, true);
		assert.deepStrictEqual(readJson(), { stackId: 'my-app-1', telemetry: { enabled: true } });
		assert.deepStrictEqual(readdirSync(join(app, '.blocks')), ['config.json']);
	});

	void it('treats a live pid with a different start time as a reused pid (stale)', {
		skip: process.platform === 'win32',
	}, () => {
		writeFileSync(lockPath, lockRecord(process.pid, 'reused-pid', 'not-this-process-start'));
		writeConfigTelemetry(configPath, false);
		assert.deepStrictEqual(readJson(), { stackId: 'my-app-1', telemetry: { enabled: false } });
		assert.deepStrictEqual(readdirSync(join(app, '.blocks')), ['config.json']);
	});

	void it('never removes a live lock: projectId skips its write, --disable and writeConfigTelemetry fail', {
		timeout: 60_000,
	}, async () => {
		const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
		try {
			assert.ok(holder.pid);
			const record = lockRecord(holder.pid, 'live-owner', null);
			writeFileSync(lockPath, record);
			const before = readFileSync(configPath, 'utf-8');

			const disable = startChild(disableCli);
			process.chdir(app);
			const startedAt = Date.now();
			const id = getProjectId();
			const waitedMs = Date.now() - startedAt;
			assert.match(id, /^[0-9a-f-]{36}$/);
			assert.ok(waitedMs < 4_000, `getProjectId waited ${waitedMs} ms; telemetry must give up quickly`);
			assert.throws(
				() => writeConfigTelemetry(configPath, false),
				/Timed out .* waiting for the lock .*config\.json\.lock/s,
			);

			const d = await disable.done;
			assert.strictEqual(d.code, 1, `stdout: ${d.stdout}\nstderr: ${d.stderr}`);
			assert.match(d.stderr, /Failed to write config: Timed out .* waiting for the lock/s);
			assert.doesNotMatch(d.stdout, /Telemetry disabled/);

			assert.strictEqual(readFileSync(lockPath, 'utf-8'), record, 'the live lock is untouched');
			assert.strictEqual(readFileSync(configPath, 'utf-8'), before, 'nothing was written');
			assert.deepStrictEqual(readdirSync(join(app, '.blocks')).sort(), ['config.json', 'config.json.lock']);
		} finally {
			holder.kill();
		}
	});
});
