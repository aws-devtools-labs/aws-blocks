// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * End to end: run `bb-auth migrate` on real `AuthCognito` app code and compile
 * the output against the real, built `@aws-blocks/bb-auth` types. Also compiles
 * every "after" snippet in `MIGRATION.md`, so the guide stays correct for `Auth`
 * as it exists at HEAD.
 */

import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import ts from 'typescript';
import { runMigrate } from './migrate/cli.js';
import { PACKAGE_DIR, REPO_ROOT, removeScratch, scratchDir, typecheck, writeFiles } from './test-support/typecheck.js';

/**
 * `packages/create-blocks-app/templates/auth-cognito/aws-blocks/index.ts` as it
 * was before the templates moved to `Auth` — vendored, so this test keeps
 * exercising real `AuthCognito` app code after the templates (and later the old
 * packages) change.
 */
const TEMPLATE = join(PACKAGE_DIR, 'src', '__fixtures__', 'migrate-e2e', 'auth-cognito-template.ts.txt');
const UMBRELLA_DIST = join(REPO_ROOT, 'packages', 'blocks', 'dist', 'index.js');

/**
 * `@aws-blocks/bb-auth-cognito`'s published `.d.ts` API, frozen at the cutover
 * (F1b) — the package is gone, so the codemod's *input* is compiled against
 * these, proving the inputs are real `AuthCognito` code. Byte-equal to the
 * built package when frozen (see `test-support/legacy-fixtures.ts`).
 */
const FROZEN_COGNITO_API = join(PACKAGE_DIR, 'src', '__fixtures__', 'authcognito-api');

/**
 * Stage the frozen `AuthCognito` API in `dir` (its own scratch directory, never
 * one the codemod runs over), plus `@aws-blocks/blocks` as it
 * was before the cutover for the names an `AuthCognito` app imports from it (the
 * umbrella re-exported them from `@aws-blocks/bb-auth-cognito`, exactly these
 * two lines), and return the `paths` that resolve both.
 */
function beforeCutover(dir: string): Record<string, string[]> {
	const api = Object.fromEntries(
		readdirSync(FROZEN_COGNITO_API)
			.filter((f) => f.endsWith('.d.ts.txt'))
			.map((f) => [
				join('.authcognito-api', f.replace(/\.txt$/, '')),
				readFileSync(join(FROZEN_COGNITO_API, f), 'utf8'),
			]),
	);
	writeFiles(dir, {
		...api,
		'umbrella-before-cutover.ts': `export * from ${JSON.stringify(UMBRELLA_DIST)};
export type { AuthCognitoOptions, AuthFlowType, CognitoUser, MFAPreference } from '@aws-blocks/bb-auth-cognito';
export { AuthCognito, AuthCognitoErrors } from '@aws-blocks/bb-auth-cognito';
`,
	});
	return {
		'@aws-blocks/bb-auth-cognito': [join(dir, '.authcognito-api', 'index.d.ts')],
		'@aws-blocks/bb-auth-cognito/ui': [join(dir, '.authcognito-api', 'ui.d.ts')],
		'@aws-blocks/blocks': [join(dir, 'umbrella-before-cutover.ts')],
	};
}

async function migrateDir(dir: string): Promise<string[]> {
	const log: string[] = [];
	const summary = await runMigrate({ cwd: dir, ts, log: (l) => log.push(l) });
	assert.deepStrictEqual(summary.failed, []);
	return summary.changed;
}

describe('bb-auth migrate — end to end, typechecked against the real Auth types', () => {
	const dirs: string[] = [];
	const scratch = (label: string): string => {
		const d = scratchDir(label);
		dirs.push(d);
		return d;
	};
	before(() => {
		assert.ok(readFileSync(join(PACKAGE_DIR, 'dist', 'index.mock.d.ts'), 'utf8').includes('class Auth'));
	});
	after(() => {
		for (const d of dirs) removeScratch(d);
	});

	test('the auth-cognito template: compiles before (AuthCognito) and after (Auth)', async () => {
		const dir = scratch('template');
		const source = readFileSync(TEMPLATE, 'utf8');
		const [file] = writeFiles(dir, { 'aws-blocks/index.ts': source });
		assert.ok(file);
		assert.deepStrictEqual(
			typecheck([file], beforeCutover(scratch('authcognito-api'))),
			[],
			'the template compiles against the frozen AuthCognito API before the run',
		);

		const changed = await migrateDir(dir);
		assert.deepStrictEqual(changed, [join('aws-blocks', 'index.ts')]);
		const out = readFileSync(file, 'utf8');
		assert.match(out, /new Auth\(scope, 'auth', \{/);
		assert.doesNotMatch(out, /new AuthCognito|import \{[^}]*\bAuthCognito\b/, 'no AuthCognito left in code');
		assert.match(out, /auth\.getUserAttributes\(context\)/);
		assert.match(out, /auth\.scanDevices\(context\)/);

		// Against the real, built umbrella: it exports `Auth` (and no longer `AuthCognito`).
		assert.deepStrictEqual(typecheck([file]), [], 'the migrated template compiles against Auth');

		// Idempotent on the real template too.
		assert.deepStrictEqual(await migrateDir(dir), []);
	});

	test('an app importing @aws-blocks/bb-auth-cognito directly compiles against @aws-blocks/bb-auth', async () => {
		const dir = scratch('direct');
		const files = writeFiles(dir, {
			'aws-blocks/auth.ts': `import { AuthCognito, AuthCognitoErrors, type CognitoUser } from '@aws-blocks/bb-auth-cognito';
import { ApiNamespace, Scope, isBlocksError } from '@aws-blocks/core';

const scope = new Scope('app');
export const auth = new AuthCognito(scope, 'auth', {
	selfSignUp: true,
	signInWith: ['username', 'email'],
	groups: ['admins', 'members'] as const,
	userAttributes: [{ name: 'tenant' }] as const,
	mfa: 'optional',
	mfaTypes: ['TOTP'],
	sessionTtlSeconds: 3600,
	admin: { actions: ['groups'] },
});

export function label(user: CognitoUser): string {
	return user.username;
}

export const api = new ApiNamespace(scope, 'api', (context) => ({
	async me() {
		try {
			const user = await auth.requireRole(context, 'admins');
			return label(user);
		} catch (e) {
			if (isBlocksError(e, AuthCognitoErrors.NotAuthorized)) return null;
			throw e;
		}
	},
	async tokens() {
		const session = await auth.fetchAuthSession(context);
		return session.userSub ?? null;
	},
	async mfa() {
		const { sharedSecret } = await auth.setUpTOTP(context);
		await auth.verifyTOTPSetup(context, '000000');
		await auth.updateMFAPreference(context, { totp: 'PREFERRED' });
		return { sharedSecret, prefs: await auth.fetchMFAPreference(context) };
	},
	async setTenant(tenant: string) {
		await auth.updateUserAttribute(context, 'custom:tenant', tenant);
	},
	async promote(username: string) {
		await auth.admin.addUserToGroup(username, 'admins');
	},
}));
`,
			'aws-blocks/routes.ts': `import type { BlocksContext } from '@aws-blocks/core';
import { auth } from './auth.js';

export async function devices(context: BlocksContext) {
	return Array.fromAsync(auth.fetchDevices(context));
}
`,
		});
		assert.deepStrictEqual(
			typecheck(files, beforeCutover(scratch('authcognito-api'))),
			[],
			'compiles against the frozen AuthCognito API before the run',
		);
		const changed = await migrateDir(dir);
		assert.deepStrictEqual([...changed].sort(), [join('aws-blocks', 'auth.ts'), join('aws-blocks', 'routes.ts')]);
		const out = readFileSync(files[0] ?? '', 'utf8');
		assert.match(out, /from '@aws-blocks\/bb-auth';/);
		assert.match(out, /mfa: \{ mode: 'optional', types: \['TOTP'\] \}/);
		assert.match(out, /updateUserAttributes\(context, \{ 'custom:tenant': tenant \}\)/);
		assert.deepStrictEqual(typecheck(files), [], 'compiles against Auth after the run');
	});

	test('a /ui import and an `import * as blocks` app compile before (AuthCognito) and after (Auth)', async () => {
		const dir = scratch('ui-and-namespace');
		const files = writeFiles(dir, {
			'src/sign-in.ts': `import { Authenticator } from '@aws-blocks/auth-common/ui';
import type { AuthStateApi } from '@aws-blocks/auth-common/ui';
import {
	cognitoOverrides,
	type CognitoActionFields,
	type CognitoActionName,
	type CognitoActionOverride,
	type CognitoAuthenticatorOptions,
	type CognitoNextStepName,
} from '@aws-blocks/bb-auth-cognito/ui';

declare const authApi: AuthStateApi;

const hidden: CognitoActionName[] = ['signUp'];
const signIn: CognitoActionOverride<'signIn'> = { fields: { username: { label: 'Email' } } };
const options: CognitoAuthenticatorOptions = { hideActions: hidden, actions: { signIn } };
export const step: CognitoNextStepName = 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP';
export type SignInField = CognitoActionFields['signIn'];
export const el: HTMLElement = Authenticator(authApi, cognitoOverrides(options));
`,
			'aws-blocks/index.ts': `import * as blocks from '@aws-blocks/blocks';

const scope = new blocks.Scope('app');
export const auth = new blocks.AuthCognito(scope, 'auth', { selfSignUp: true, sessionTtlSeconds: 3600 });

export function label(user: blocks.CognitoUser): string {
	return user.username;
}

export const api = new blocks.ApiNamespace(scope, 'api', (context) => ({
	async email() {
		try {
			return (await auth.fetchUserAttributes(context)).email ?? null;
		} catch (e) {
			if (blocks.isBlocksError(e, blocks.AuthCognitoErrors.NotAuthorized)) return null;
			throw e;
		}
	},
}));
`,
		});
		assert.deepStrictEqual(
			typecheck(files, beforeCutover(scratch('authcognito-api'))),
			[],
			'compiles against the frozen AuthCognito API (with /ui) before the run',
		);
		const changed = await migrateDir(dir);
		assert.deepStrictEqual([...changed].sort(), [join('aws-blocks', 'index.ts'), join('src', 'sign-in.ts')]);
		const ui = readFileSync(files[0] ?? '', 'utf8');
		assert.match(ui, /from '@aws-blocks\/bb-auth\/ui';/);
		assert.match(ui, /authOverrides\(options\)/);
		assert.doesNotMatch(ui, /import \{\s*\}/, 'never an empty import');
		const backend = readFileSync(files[1] ?? '', 'utf8');
		assert.match(backend, /new blocks\.Auth\(scope, 'auth', \{/);
		assert.match(backend, /blocks\.AuthErrors\.NotAuthorized/);
		assert.match(backend, /auth\.getUserAttributes\(context\)/);
		assert.deepStrictEqual(typecheck(files), [], 'compiles against Auth after the run');
		assert.deepStrictEqual(await migrateDir(dir), [], 'idempotent');
	});

	test('every "after" snippet in MIGRATION.md compiles against Auth', () => {
		const md = readFileSync(join(PACKAGE_DIR, 'MIGRATION.md'), 'utf8');
		const snippets = [...md.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
		const after = snippets.filter((s) => !s.startsWith('// Before'));
		assert.ok(after.length >= 5, `found ${after.length} snippets to compile`);
		const dir = scratch('migration-md');
		const files = writeFiles(
			dir,
			Object.fromEntries(after.map((s, i) => [`snippet-${i}.ts`, `${s}\nexport {};\n`])),
		);
		assert.deepStrictEqual(typecheck(files), []);
	});
});
