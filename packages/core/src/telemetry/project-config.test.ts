// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// `.blocks/config.json` holds the committed `stackId` next to the telemetry keys, so
// the telemetry writers must never drop it: not on a BOM, not on a file they can't
// parse, and not when several processes write at once.

import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

void describe('concurrent writers never lose stackId', () => {
	const PROCESSES = 12;
	const ROUNDS = 5;
	const WRITES_PER_PROCESS = 25;

	/** Spawn one writer; resolves with its exit code and stderr. */
	function startWriter(index: number): Promise<{ code: number | null; stderr: string }> {
		// Even writers toggle telemetry.enabled; odd writers also read (and, until one wins,
		// create) telemetry.projectId via getProjectId, so both write paths race each other.
		const body =
			index % 2 === 0
				? `import { writeConfigTelemetry } from ${JSON.stringify(configWriterUrl)};
for (let i = 0; i < ${WRITES_PER_PROCESS}; i++) writeConfigTelemetry(${JSON.stringify(configPath)}, i % 2 === 0);`
				: `import { getProjectId } from ${JSON.stringify(identifiersUrl)};
import { writeConfigTelemetry } from ${JSON.stringify(configWriterUrl)};
for (let i = 0; i < ${WRITES_PER_PROCESS}; i++) { getProjectId(); writeConfigTelemetry(${JSON.stringify(configPath)}, true); }`;
		return new Promise((resolve, reject) => {
			const child = spawn(process.execPath, ['--input-type=module', '-e', body], {
				cwd: app,
				stdio: ['ignore', 'ignore', 'pipe'],
				env: {
					...process.env,
					HOME: app,
					USERPROFILE: app,
					AWS_BLOCKS_DISABLE_TELEMETRY: '',
					NODE_OPTIONS: '',
				},
			});
			let stderr = '';
			child.stderr.on('data', (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.on('error', reject);
			child.on('close', (code) => resolve({ code, stderr }));
		});
	}

	void it(`${PROCESSES} parallel processes x ${ROUNDS} rounds keep stackId and valid JSON`, {
		timeout: 120_000,
	}, async () => {
		const lost: number[] = [];
		for (let round = 0; round < ROUNDS; round++) {
			writeFileSync(configPath, JSON.stringify({ stackId: 'my-app-1', other: 'keep' }, null, 2));
			const results = await Promise.all(Array.from({ length: PROCESSES }, (_, i) => startWriter(i)));
			for (const r of results) assert.strictEqual(r.code, 0, `a writer failed: ${r.stderr}`);
			const config = readJson();
			if (config.stackId !== 'my-app-1' || config.other !== 'keep') lost.push(round);
			const leftovers = readdirSync(join(app, '.blocks')).filter((f) => f !== 'config.json');
			assert.deepStrictEqual(leftovers, [], 'no temp files left behind');
		}
		assert.deepStrictEqual(lost, [], `stackId/other lost in rounds ${lost.join(', ')} of ${ROUNDS}`);
	});
});
