// Tests for steps/stage-artifacts.mjs (step 4c): the only copy of a cell's files that is published.
// Runs the real step in a child with fake job credentials in its env (assembled at runtime so no
// literal looks like a real key) and checks what lands in STAGE_DIR — and what never does.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const STEP = join(dirname(fileURLToPath(import.meta.url)), '..', 'stage-artifacts.mjs');
const SECRET = `fakeSecret/${'s'.repeat(29)}`;
const SESSION = `IQoJb3JpZ2luX2Vj${'t'.repeat(60)}`;
const OIDC_REQ = `fake-oidc-request-${'r'.repeat(30)}`;
const GH = `ghs_${'g'.repeat(36)}`;
const UNKNOWN = `unknown${'u'.repeat(33)}`; // a credential with no format and no known exact value
const JOB_ENV = { AWS_SECRET_ACCESS_KEY: SECRET, AWS_SESSION_TOKEN: SESSION, ACTIONS_ID_TOKEN_REQUEST_TOKEN: OIDC_REQ };
const ALL = [SECRET, SESSION, OIDC_REQ, GH, UNKNOWN];

function walk(dir, out = []) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'stage-artifacts-'));
	const ws = join(root, 'bench-app');
	mkdirSync(join(ws, 'src'), { recursive: true });
	mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true });
	const files = {
		result: join(root, 'result.json'),
		trace: join(root, 'trace.json'),
		metrics: join(root, 'metrics.json'),
		cmdLog: join(root, 'commands.jsonl'),
	};
	writeFileSync(
		files.result,
		JSON.stringify({ final_message: `done ${SECRET}`, dev_log_tail: `AWS_SESSION_TOKEN=${SESSION}`, Credentials: { SecretAccessKey: UNKNOWN }, tokens_in: 7 }),
	);
	writeFileSync(files.trace, JSON.stringify([{ name: 'bash', result: `env\nACTIONS_ID_TOKEN_REQUEST_TOKEN=${OIDC_REQ}` }]));
	writeFileSync(files.metrics, JSON.stringify({ toolUsage: { [GH]: { callCount: 1 } } }));
	writeFileSync(files.cmdLog, `${JSON.stringify({ command: 'env', stdout: `AWS_SECRET_ACCESS_KEY=${SECRET}\n` })}\n`);
	writeFileSync(join(ws, 'src', 'leak.ts'), `// ${SECRET}\nexport const t = '${GH}';\n`);
	writeFileSync(join(ws, 'src', 'app.ts'), 'const API_KEY = process.env.X;\n');
	writeFileSync(join(ws, 'export.json'), JSON.stringify({ Credentials: { SecretAccessKey: UNKNOWN, Expiration: 'x' } }));
	writeFileSync(join(ws, 'package.json'), '{\n  "name": "app",\n  "author": "someone"\n}\n');
	writeFileSync(join(ws, 'node_modules', 'pkg', 'index.js'), `// ${SECRET}\n`);
	writeFileSync(join(ws, 'src', 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(SECRET)]));
	writeFileSync(join(ws, 'src', 'latin1.txt'), Buffer.from([0x66, 0xe9, 0x65])); // invalid UTF-8
	writeFileSync(join(ws, 'big.txt'), Buffer.alloc(21 * 1024 * 1024, 0x61));
	writeFileSync(join(ws, 'secret.txt'), SECRET);
	chmodSync(join(ws, 'secret.txt'), 0o000);
	writeFileSync(join(ws, `${OIDC_REQ}.txt`), 'clean body');
	writeFileSync(join(ws, `newline\n${'x'}.ts`), 'clean body');
	mkdirSync(join(ws, `dir-${GH}`));
	writeFileSync(join(ws, `dir-${GH}`, 'inner.ts'), 'clean');
	symlinkSync('/proc/self/environ', join(ws, 'notes.txt'));
	return { root, ws, files, stage: join(root, 'stage') };
}

function run(env) {
	return spawnSync(process.execPath, [STEP], {
		env: { PATH: process.env.PATH, ...JOB_ENV, BENCH_AGENT_USER: 'bench-no-such-user-x', ...env },
		encoding: 'utf-8',
	});
}

function cleanup(root) {
	try {
		chmodSync(join(root, 'bench-app', 'secret.txt'), 0o600);
	} catch {
		/* already gone */
	}
	rmSync(root, { recursive: true, force: true });
}

describe('stage-artifacts.mjs (the published copy)', () => {
	it('stages redacted harness files + source; drops links, binaries, oversized/unreadable files, bad names', () => {
		const { root, ws, files, stage } = fixture();
		try {
			const r = run({ STAGE_DIR: stage, RESULT_PATH: files.result, TRACE: files.trace, METRICS: files.metrics, BENCH_CMD_LOG: files.cmdLog, WORKSPACE: ws });
			assert.equal(r.status, 0, r.stderr);
			// Nothing secret anywhere in the staged tree — contents OR names — or in the step's messages.
			for (const p of walk(stage)) {
				for (const v of ALL) assert.equal(p.includes(v), false, `secret in staged path ${JSON.stringify(p)}`);
				const text = readFileSync(p, 'utf-8');
				for (const v of ALL) assert.equal(text.includes(v), false, `${p} leaked a secret`);
			}
			for (const v of ALL) assert.equal(r.stderr.includes(v), false, 'messages must not print secrets');
			// Harness files: valid JSON, key-aware (an unknown SecretAccessKey is gone), numbers kept.
			const result = JSON.parse(readFileSync(join(stage, 'result', 'result.json'), 'utf-8'));
			assert.equal(result.tokens_in, 7);
			assert.equal(result.Credentials.SecretAccessKey, '***REDACTED***');
			JSON.parse(readFileSync(join(stage, 'trace', 'trace.json'), 'utf-8'));
			for (const l of readFileSync(join(stage, 'trace', 'commands.jsonl'), 'utf-8').split('\n').filter(Boolean)) JSON.parse(l);
			// Source: code is not mangled, JSON is key-aware, untouched JSON keeps its bytes.
			const src = join(stage, 'source');
			assert.equal(readFileSync(join(src, 'src', 'app.ts'), 'utf-8'), 'const API_KEY = process.env.X;\n');
			assert.equal(JSON.parse(readFileSync(join(src, 'export.json'), 'utf-8')).Credentials.SecretAccessKey, '***REDACTED***');
			assert.equal(readFileSync(join(src, 'package.json'), 'utf-8'), readFileSync(join(ws, 'package.json'), 'utf-8'));
			// Dropped, never published.
			for (const gone of ['notes.txt', 'big.txt', 'secret.txt', join('src', 'blob.bin'), join('src', 'latin1.txt'), 'node_modules']) {
				assert.equal(existsSync(join(src, gone)), false, `${gone} must not be staged`);
			}
			assert.deepEqual(readdirSync(src).filter((n) => n.includes('newline') || n.startsWith('dir-') || n.startsWith('fake-oidc')), []);
			// The originals are only read, never rewritten.
			assert.match(readFileSync(join(ws, 'src', 'leak.ts'), 'utf-8'), /fakeSecret/);
		} finally {
			cleanup(root);
		}
	});

	it('fails closed — nothing staged — when the workspace root or an ancestor is a symlink', () => {
		const { root, ws, files, stage } = fixture();
		try {
			const link = join(root, 'linked-app');
			symlinkSync(ws, link);
			for (const wsPath of [link, join(link, 'src')]) {
				const r = run({ STAGE_DIR: stage, RESULT_PATH: files.result, WORKSPACE: wsPath });
				assert.equal(r.status, 1);
				assert.match(r.stderr, /goes through a symlink; nothing will be published/);
				assert.equal(existsSync(stage), false, 'a failed sanitize must leave nothing to upload');
			}
		} finally {
			cleanup(root);
		}
	});

	it('drops a harness file that is a symlink instead of following it', () => {
		const { root, stage } = fixture();
		try {
			const linkResult = join(root, 'linked-result.json');
			symlinkSync('/proc/self/environ', linkResult);
			const r = run({ STAGE_DIR: stage, RESULT_PATH: linkResult });
			assert.equal(r.status, 0, r.stderr);
			assert.equal(existsSync(join(stage, 'result', 'result.json')), false);
			assert.match(r.stderr, /dropped .*linked-result\.json.*: is a symlink/);
		} finally {
			cleanup(root);
		}
	});

	it('is a no-op on missing inputs', () => {
		const stage = join(mkdtempSync(join(tmpdir(), 'stage-empty-')), 'stage');
		try {
			const r = run({ STAGE_DIR: stage, RESULT_PATH: '/nonexistent/result.json', BENCH_CMD_LOG: '/nonexistent/c.jsonl' });
			assert.equal(r.status, 0, r.stderr);
			assert.deepEqual(walk(stage), []);
		} finally {
			rmSync(dirname(stage), { recursive: true, force: true });
		}
	});
});
