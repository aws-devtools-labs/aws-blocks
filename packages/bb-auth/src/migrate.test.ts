// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `bb-auth migrate`: the id-preservation guarantee, TODO emission, dry run,
 * "touch only files that change", and the bin as built in `dist/`. The
 * per-rule input → expected fixtures live in `migrate-fixtures.test.ts`.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import ts from 'typescript';
import { loadTypeScript } from './migrate/cli.js';
import { TODO_TAG } from './migrate/rules.js';
import { unifiedDiff } from './migrate/text.js';
import { assertIdsPreserved, IdPreservationError, transformFile } from './migrate/transform.js';
import { migrate, readTree, stageCase } from './test-support/migrate-fixtures.js';
import { PACKAGE_DIR } from './test-support/typecheck.js';

/** The first two arguments of every `new X(…)`, in source order. */
function constructorArgs(text: string): { callee: string; args: string[] }[] {
	const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);
	const out: { callee: string; args: string[] }[] = [];
	const visit = (n: ts.Node): void => {
		if (ts.isNewExpression(n)) {
			out.push({
				callee: n.expression.getText(sf),
				args: (n.arguments ?? []).slice(0, 2).map((a) => a.getText(sf)),
			});
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return out;
}

async function withCase<T>(name: string, fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = stageCase(name);
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('bb-auth migrate — the block id is never rewritten', () => {
	test('variable, template-literal, computed and class-name-derived ids are byte-identical after the run', async () => {
		await withCase('id-preservation', async (dir) => {
			const before = readFileSync(join(dir, 'index.ts'), 'utf8');
			await migrate(dir);
			const after = readFileSync(join(dir, 'index.ts'), 'utf8');
			const was = constructorArgs(before).filter((c) => c.callee === 'AuthCognito');
			const now = constructorArgs(after).filter((c) => c.callee === 'Auth');
			assert.strictEqual(was.length, 5);
			assert.deepStrictEqual(
				now.map((c) => c.args),
				was.map((c) => c.args),
			);
			assert.deepStrictEqual(
				now.map((c) => c.args[1]),
				[
					'authId',
					// biome-ignore lint/suspicious/noTemplateCurlyInString: user-facing text naming the `${iss}:${sub}` id format, not a template
					'`auth-${stage}`',
					"['auth', stage].join('-')",
					'AuthCognito.name.toLowerCase()',
					"'SessionExpiredException'",
				],
			);
		});
	});

	test('an id that mentions the old class name is left alone, with a TODO', async () => {
		await withCase('id-preservation', async (dir) => {
			await migrate(dir);
			const after = readFileSync(join(dir, 'index.ts'), 'utf8');
			assert.match(after, /new Auth\(scope, AuthCognito\.name\.toLowerCase\(\)/);
			assert.match(after, /TODO\(aws-blocks-auth-migrate\): the block id expression mentions AuthCognito/);
		});
	});

	test('an id that looks like an old error name is not touched by the error-name rename', () => {
		const text =
			"import { AuthBasic } from '@aws-blocks/bb-auth-basic';\nexport const a = new AuthBasic(scope, 'InvalidCodeException');\n";
		const out = transformFile(ts, '/app/x.ts', text, { blocks: new Set(['basic']), instanceExports: new Map() });
		assert.match(out.output, /new Auth\(scope, 'InvalidCodeException'\)/);
	});

	test('the guard refuses an output whose id changed', () => {
		const before = "import { AuthCognito } from '@aws-blocks/bb-auth-cognito';\nnew AuthCognito(scope, 'auth');\n";
		const after = "import { Auth } from '@aws-blocks/bb-auth';\nnew Auth(scope, 'users');\n";
		assert.throws(() => assertIdsPreserved(ts, 'x.ts', before, after), IdPreservationError);
	});

	test('the guard refuses an output whose scope changed, or that lost a constructor call', () => {
		const before = "import { AuthCognito } from '@aws-blocks/bb-auth-cognito';\nnew AuthCognito(scope, 'auth');\n";
		assert.throws(() => assertIdsPreserved(ts, 'x.ts', before, "new Auth(other, 'auth');\n"), IdPreservationError);
		assert.throws(() => assertIdsPreserved(ts, 'x.ts', before, '\n'), IdPreservationError);
		assert.doesNotThrow(() => assertIdsPreserved(ts, 'x.ts', before, "new Auth(scope, 'auth');\n"));
	});
});

describe('bb-auth migrate — TODOs where a person must decide', () => {
	const cases: [string, string, RegExp][] = [
		['basic', 'index.ts', /AuthBasic has no migration path to Auth/],
		['basic', 'index.ts', /InvalidCodeException split in two/],
		['basic', 'frontend.ts', /review this auth error check/],
		['cognito-methods', 'index.ts', /review this auth error check/],
		['cognito-methods', 'index.ts', /updateUserAttributes\(\) returns a record/],
		['oidc-cognito-federated', 'index.ts', /users of this provider get a NEW userId/],
		['oidc-cognito-federated', 'index.ts', /deploy twice/],
		['oidc-direct', 'index.ts', /provider secrets must be AppSetting references/],
		['oidc-direct', 'client.ts', /getClient\(\) is gone/],
		['by-reference', 'index.ts', /options are passed by reference/],
		['oidc-subpaths', 'client.ts', /AuthOIDCClient, handle401 have no equivalent/],
		['oidc-subpaths', 'client.ts', /Auth has no client middleware/],
		['oidc-subpaths', 'mixed.ts', /AuthOIDCClient has no equivalent/],
	];
	for (const [name, file, pattern] of cases) {
		test(`${name}/${file}: ${pattern.source}`, async () => {
			await withCase(name, async (dir) => {
				await migrate(dir);
				const text = readFileSync(join(dir, file), 'utf8');
				const todoLines = text
					.split('\n')
					.filter((l) => l.includes(`// ${TODO_TAG}:`) || /^\s*\/\/ {3}/.test(l));
				assert.ok(
					todoLines.some((l) => pattern.test(l)),
					`expected a TODO matching ${pattern} in ${file}`,
				);
			});
		});
	}

	test('the summary counts the TODOs it added', async () => {
		await withCase('basic', async (dir) => {
			const { todos, log } = await migrate(dir);
			const written = Object.values(readTree(dir)).join('\n').split(`// ${TODO_TAG}:`).length - 1;
			assert.strictEqual(todos, written);
			assert.ok(log.some((l) => l.includes(`search for ${TODO_TAG}`)));
		});
	});

	// A4: the obvious fix for EMAIL_OTP — wrapping the block's own pool with
	// `Auth.fromExisting` — removes the pool from the stack and deletes it.
	test("preferredChallenge 'EMAIL_OTP': the TODO and the printed summary warn against wrapping the block's own pool", async () => {
		const dir = mkdtempSync(join(tmpdir(), 'bb-auth-migrate-email-otp-'));
		try {
			writeFileSync(
				join(dir, 'index.ts'),
				`import { AuthCognito } from '@aws-blocks/bb-auth-cognito';
import { Scope } from '@aws-blocks/core';

const scope = new Scope('app');
export const auth = new AuthCognito(scope, 'auth', {
	signInWith: 'email',
	authFlowType: 'USER_AUTH',
	preferredChallenge: 'EMAIL_OTP',
});
`,
			);
			const { log } = await migrate(dir);
			const todo = readFileSync(join(dir, 'index.ts'), 'utf8')
				.split('\n')
				.filter((l) => l.includes(`// ${TODO_TAG}:`) || /^\s*\/\/ {3}/.test(l))
				.join(' ');
			assert.match(todo, /preferredChallenge 'EMAIL_OTP' needs a pool with an Amazon SES sender/);
			assert.match(todo, /do NOT wrap this block's OWN pool with userPool: Auth\.fromExisting/);
			assert.match(todo, /DELETES the pool and every user in it/);
			assert.match(todo, /retain \+ cdk import runbook/);
			const printed = log.join('\n');
			assert.match(printed, /WARNING: preferredChallenge 'EMAIL_OTP'/);
			assert.match(printed, /deletes it and every user in it/);
			assert.strictEqual(printed.split("WARNING: preferredChallenge 'EMAIL_OTP'").length - 1, 1, 'printed once');
			assert.match(
				printed,
				/Deploy this output with no other configuration change, then commit aws-blocks\/baselines\//,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('no EMAIL_OTP, no pool-deletion warning in the summary', async () => {
		await withCase('cognito-options', async (dir) => {
			const { log } = await migrate(dir);
			assert.doesNotMatch(log.join('\n'), /WARNING: preferredChallenge/);
		});
	});

	test('an already-migrated app gets no TODOs and no edits', async () => {
		await withCase('untouched', async (dir) => {
			const before = readTree(dir);
			const { changed } = await migrate(dir);
			assert.deepStrictEqual(changed, []);
			assert.deepStrictEqual(readTree(dir), before);
		});
	});
});

describe('bb-auth migrate — never a silent empty import', () => {
	const project = { blocks: new Set<'cognito'>(['cognito']), instanceExports: new Map() };

	test('an import whose name list would end up empty is left as it is, with a TODO, and needs attention', () => {
		for (const spec of ['@aws-blocks/bb-auth-cognito/ui', '@aws-blocks/bb-auth-cognito']) {
			const input = `import {} from '${spec}';\nexport const x = 1;\n`;
			const r = transformFile(ts, '/app/x.ts', input, project);
			assert.ok(!r.output.includes('import {  }'), r.output);
			assert.match(r.output, new RegExp(`\\n?import \\{\\} from '${spec.replace(/\//g, '\\/')}';`));
			assert.match(r.output, /this import names nothing/);
			assert.strictEqual(r.attention.length, 1, spec);
		}
	});

	test('a /ui import keeps (and renames) every name: never `import {  }`', () => {
		const input = "import { cognitoOverrides, type CognitoActionName } from '@aws-blocks/bb-auth-cognito/ui';\n";
		const r = transformFile(ts, '/app/x.ts', input, project);
		assert.strictEqual(r.output, "import { authOverrides, type AuthActionName } from '@aws-blocks/bb-auth/ui';\n");
		assert.deepStrictEqual(r.attention, []);
	});

	test('the summary reports such a file as "needs attention", not as changed', async () => {
		const { mkdtempSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const dir = mkdtempSync(join(tmpdir(), 'bb-auth-migrate-attention-'));
		try {
			writeFileSync(join(dir, 'empty.ts'), "import {} from '@aws-blocks/bb-auth-cognito/ui';\n");
			writeFileSync(
				join(dir, 'ui.ts'),
				"import { cognitoOverrides } from '@aws-blocks/bb-auth-cognito/ui';\nexport const o = cognitoOverrides({});\n",
			);
			const log: string[] = [];
			const { runMigrate } = await import('./migrate/cli.js');
			const summary = await runMigrate({ cwd: dir, ts, log: (l) => log.push(l) });
			assert.deepStrictEqual(
				summary.attention.map((a) => a.file),
				['empty.ts'],
			);
			const out = log.join('\n');
			assert.match(out, /changed 1; 1 need\(s\) attention/);
			assert.match(out, /⚠ empty\.ts: needs attention/);
			assert.match(out, /^ {2}ui\.ts$/m, 'the rewritten file is listed as changed');
			assert.doesNotMatch(out, /^ {2}empty\.ts/m, 'never listed as rewritten');
			assert.match(readFileSync(join(dir, 'ui.ts'), 'utf8'), /authOverrides\(\{\}\)/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('bb-auth migrate — dry run and file handling', () => {
	test('--dry-run prints a unified diff and writes nothing', async () => {
		await withCase('cognito-options', async (dir) => {
			const before = readTree(dir);
			const { changed, log } = await migrate(dir, true);
			assert.deepStrictEqual(changed, ['index.ts']);
			assert.deepStrictEqual(readTree(dir), before, 'nothing written');
			const out = log.join('\n');
			assert.match(out, /^--- a\/index\.ts$/m);
			assert.match(out, /^\+\+\+ b\/index\.ts$/m);
			assert.match(out, /^-export const auth = new AuthCognito\(scope, 'auth', \{$/m);
			assert.match(out, /^\+export const auth = new Auth\(scope, 'auth', \{$/m);
			assert.match(out, /dry run — nothing written/);
		});
	});

	test('files that need no change are not rewritten (mtime untouched)', async () => {
		await withCase('cross-file', async (dir) => {
			const file = join(dir, 'unrelated.ts');
			const past = new Date('2020-01-01T00:00:00Z');
			const { utimesSync } = await import('node:fs');
			utimesSync(file, past, past);
			const { changed } = await migrate(dir);
			assert.ok(!changed.includes('unrelated.ts'));
			assert.strictEqual(statSync(file).mtimeMs, past.getTime());
		});
	});

	test('skips node_modules, dist and dot-directories', async () => {
		await withCase('cross-file', async (dir) => {
			const { mkdirSync } = await import('node:fs');
			for (const sub of ['node_modules/x', 'dist', '.cache']) {
				mkdirSync(join(dir, sub), { recursive: true });
				writeFileSync(
					join(dir, sub, 'index.ts'),
					"import { AuthCognito } from '@aws-blocks/bb-auth-cognito';\nnew AuthCognito(s, 'a');\n",
				);
			}
			const { changed } = await migrate(dir);
			assert.deepStrictEqual([...changed].sort(), ['auth.ts', 'helpers.ts', 'routes.ts']);
		});
	});

	test('unifiedDiff: hunks carry correct line ranges', () => {
		const diff = unifiedDiff('f.ts', 'a\nb\nc\nd\n', 'a\nB\nc\nd\n');
		assert.strictEqual(diff, '--- a/f.ts\n+++ b/f.ts\n@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n d\n \n');
	});

	test('loadTypeScript finds a TypeScript without a static dependency', async () => {
		const loaded = await loadTypeScript(PACKAGE_DIR);
		assert.strictEqual(typeof loaded.createSourceFile, 'function');
	});
});

describe('bb-auth migrate — the published bin (dist/migrate/bin.js)', () => {
	const bin = join(PACKAGE_DIR, 'dist', 'migrate', 'bin.js');
	const run = (args: string[], cwd: string) =>
		spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', timeout: 60_000 });

	test('package.json wires `bb-auth` to the built bin, and ships MIGRATION.md', () => {
		const pkg: { bin?: Record<string, string>; files?: string[] } = JSON.parse(
			readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'),
		);
		assert.strictEqual(pkg.bin?.['bb-auth'], './dist/migrate/bin.js');
		assert.ok(pkg.files?.includes('MIGRATION.md'));
		assert.ok(pkg.files?.includes('dist'));
		assert.ok(readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node'));
	});

	test('`migrate --dry-run` prints the diff and exits 0 without writing', async () => {
		await withCase('cognito-methods', async (dir) => {
			const before = readTree(dir);
			const r = run(['migrate', '--dry-run'], dir);
			assert.strictEqual(r.status, 0, r.stderr);
			assert.match(r.stdout, /\+\+\+ b\/index\.ts/);
			assert.match(r.stdout, /would change 1/);
			assert.deepStrictEqual(readTree(dir), before);
		});
	});

	test('`migrate <path>` writes, then a second run is a no-op', async () => {
		await withCase('cognito-methods', async (dir) => {
			const first = run(['migrate', '.'], dir);
			assert.strictEqual(first.status, 0, first.stderr);
			assert.match(first.stdout, /changed 1/);
			const after = readTree(dir);
			const second = run(['migrate'], dir);
			assert.strictEqual(second.status, 0, second.stderr);
			assert.match(second.stdout, /changed 0/);
			assert.deepStrictEqual(readTree(dir), after);
		});
	});

	test('--help exits 0; unknown commands and options exit 2', () => {
		assert.strictEqual(run(['--help'], PACKAGE_DIR).status, 0);
		assert.strictEqual(run(['migrate', '--help'], PACKAGE_DIR).status, 0);
		assert.strictEqual(run(['frobnicate'], PACKAGE_DIR).status, 2);
		assert.strictEqual(run(['migrate', '--yes'], PACKAGE_DIR).status, 2);
		assert.strictEqual(run([], PACKAGE_DIR).status, 2);
	});
});
