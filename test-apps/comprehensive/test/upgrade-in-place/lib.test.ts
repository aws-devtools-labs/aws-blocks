// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Offline unit tests for the upgrade-in-place harness's pure logic. No AWS, no
 * network, no child processes. Run: `npx tsx --test test/upgrade-in-place/lib.test.ts`
 * (from `test-apps/comprehensive`; also part of `npm test`).
 *
 * Fixtures (`fixtures/`):
 * - `template.auth-cognito.json` / `template.auth.json` — recorded by the
 *   dry-run (`cdk synth` under `--conditions=cdk`), trimmed to the auth block.
 *   In `template.auth.json` the session-store table was then edited by hand to
 *   what this revision synthesizes (child id `session-store`).
 * - `cdk-diff.clean.txt` — recorded `cdk diff --template` output, AuthCognito → Auth,
 *   plus the two lines for the session tables (`[-]` the old one, `[+]` the new
 *   one), added by hand in the form `cdk diff` prints.
 * - `cdk-diff.pool-renamed.txt` — recorded the same way with bb-auth's `pool`
 *   child id deliberately renamed to `userPool` in its built output.
 * - `stack-events.*.json` — DescribeStackEvents response shape, constructed
 *   (this machine has no sandbox account to record from).
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	AUTH_POOL_GUARD_TYPE,
	type CfnTemplate,
	classifyStackStatus,
	clearsCookie,
	compareContinuity,
	compareDeployedIdentity,
	DEFAULT_BASE_REF,
	type DeployedIdentity,
	DIFF_PROTECTED_TYPES,
	DRY_RUN_SUFFIX,
	decodeRpcResponse,
	encodeRpcRequest,
	extractSessionCookie,
	extractUpdateFailures,
	findDiffViolations,
	formatUpdateFailureReport,
	HARNESS_AWS_ACTIONS,
	LEGACY_PACKAGE_DIR,
	LEGACY_PACKAGE_NAME,
	legacyPackageProblem,
	OPT_IN_ENV,
	offlineEnv,
	parseCdkDiff,
	parseHarnessArgs,
	protectedResources,
	realModeRefusal,
	removalOutcome,
	type StackEventLike,
	sessionStoreDiffErrors,
	stableStringify,
	stackNameFor,
	UNAUTHENTICATED_AWS_ACTIONS,
	UsageError,
	upgradeRevisionErrors,
} from './lib.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtureText = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const fixtureJson = <T>(name: string): T => JSON.parse(fixtureText(name)) as T;
/** A fresh deep copy each call, so a test can mutate it. */
const template = (name: 'auth-cognito' | 'auth'): CfnTemplate => fixtureJson<CfnTemplate>(`template.${name}.json`);
const events = (name: string): StackEventLike[] => fixtureJson<{ StackEvents: StackEventLike[] }>(name).StackEvents;

const POOL = 'upgradeauthpool556377DE';
const CLIENT = 'upgradeauthclientDFB740B2';
/** The sessions table of the earlier release (child id `sessions`). */
const TABLE = 'upgradeauthsessionstable29328177';
/** `Auth`'s session-store table (child id `session-store`). */
const STORE = 'upgradeauthsessionstoretableC85094EE';
const STACK = 'bb-test-upgrade-123-1';

function renameLogicalId(t: CfnTemplate, from: string, to: string, newPath?: string): CfnTemplate {
	const resource = t.Resources[from];
	delete t.Resources[from];
	if (newPath) resource.Metadata = { ...resource.Metadata, 'aws:cdk:path': newPath };
	t.Resources[to] = resource;
	return t;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('parseHarnessArgs', () => {
	test('real mode by default; CI suffix from GITHUB_RUN_ID; defaults', () => {
		const o = parseHarnessArgs([], { GITHUB_RUN_ID: '987', GITHUB_RUN_ATTEMPT: '2' });
		assert.deepStrictEqual(o, {
			mode: 'real',
			suffix: 'upgrade-987-2',
			baseRef: DEFAULT_BASE_REF,
			keepBase: false,
			build: true,
			skipRuntimeChecks: false,
			help: false,
		});
	});

	test('outside CI the default suffix is upgrade-<base36 timestamp>', () => {
		const o = parseHarnessArgs([], {}, () => 1_700_000_000_000);
		assert.strictEqual(o.suffix, `upgrade-${(1_700_000_000_000).toString(36)}`);
	});

	test('--dry-run (or BLOCKS_UPGRADE_DRY_RUN=1) selects the offline mode with a fixed suffix', () => {
		assert.strictEqual(parseHarnessArgs(['--dry-run'], {}).mode, 'dry-run');
		assert.strictEqual(parseHarnessArgs(['--dry-run'], {}).suffix, DRY_RUN_SUFFIX);
		assert.strictEqual(parseHarnessArgs([], { BLOCKS_UPGRADE_DRY_RUN: '1' }).mode, 'dry-run');
		assert.strictEqual(parseHarnessArgs([], { BLOCKS_UPGRADE_DRY_RUN: 'true' }).mode, 'real');
	});

	test('flags win over env vars; both --flag value and --flag=value forms', () => {
		const env = {
			BLOCKS_STACK_SUFFIX: 'upgrade-from-env',
			BLOCKS_UPGRADE_BASE_REF: 'env-ref',
			BLOCKS_UPGRADE_BASE_DIR: '/env/dir',
		};
		const fromEnv = parseHarnessArgs([], env);
		assert.strictEqual(fromEnv.suffix, 'upgrade-from-env');
		assert.strictEqual(fromEnv.baseRef, 'env-ref');
		assert.strictEqual(fromEnv.baseDir, '/env/dir');
		const fromFlags = parseHarnessArgs(
			['--suffix', 'upgrade-from-flag', '--base-ref=v1.2.3', '--base-dir', '/flag/dir'],
			env,
		);
		assert.strictEqual(fromFlags.suffix, 'upgrade-from-flag');
		assert.strictEqual(fromFlags.baseRef, 'v1.2.3');
		assert.strictEqual(fromFlags.baseDir, '/flag/dir');
	});

	test('switches', () => {
		const o = parseHarnessArgs(['--keep-base', '--no-build', '--skip-runtime-checks', '-h'], {});
		assert.strictEqual(o.keepBase, true);
		assert.strictEqual(o.build, false);
		assert.strictEqual(o.skipRuntimeChecks, true);
		assert.strictEqual(o.help, true);
	});

	test("rejects a suffix that is not a dedicated 'upgrade-' suffix (e.g. the PR e2e jobs' pr-<n>-<attempt>)", () => {
		for (const suffix of [
			'pr-12-1',
			'upgrade-',
			'Upgrade-1',
			'upgrade-UPPER',
			'upgrade-x-',
			`upgrade-${'a'.repeat(41)}`,
		]) {
			assert.throws(() => parseHarnessArgs([], { BLOCKS_STACK_SUFFIX: suffix }), UsageError, suffix);
		}
		assert.doesNotThrow(() => parseHarnessArgs([], { BLOCKS_STACK_SUFFIX: `upgrade-${'a'.repeat(40)}` }));
	});

	test('a blank env var counts as unset', () => {
		assert.strictEqual(parseHarnessArgs(['--dry-run'], { BLOCKS_STACK_SUFFIX: '  ' }).suffix, DRY_RUN_SUFFIX);
	});

	test('rejects unknown arguments and missing values', () => {
		assert.throws(() => parseHarnessArgs(['--deploy'], {}), /Unknown argument '--deploy'/);
		assert.throws(() => parseHarnessArgs(['--suffix'], {}), /--suffix needs a value/);
		assert.throws(() => parseHarnessArgs(['--suffix', '--dry-run'], {}), /--suffix needs a value/);
		assert.throws(() => parseHarnessArgs(['--base-ref='], {}), /--base-ref needs a value/);
	});

	test('stackNameFor', () => {
		assert.strictEqual(stackNameFor('upgrade-1-1'), 'bb-test-upgrade-1-1');
	});
});

describe('the base revision: pinned to the last AuthCognito release, and refused unless it ships AuthCognito', () => {
	test('the default is a bb-auth-cognito release tag, never a branch that moves past the cutover', () => {
		assert.match(DEFAULT_BASE_REF, /^@aws-blocks\/bb-auth-cognito@\d+\.\d+\.\d+$/);
		assert.notStrictEqual(DEFAULT_BASE_REF, 'origin/main');
		assert.strictEqual(parseHarnessArgs(['--dry-run'], {}).baseRef, DEFAULT_BASE_REF);
		// An empty override (the workflow's default input) falls back to the pinned tag.
		assert.strictEqual(parseHarnessArgs(['--dry-run'], { BLOCKS_UPGRADE_BASE_REF: '' }).baseRef, DEFAULT_BASE_REF);
		assert.strictEqual(parseHarnessArgs(['--dry-run'], { BLOCKS_UPGRADE_BASE_REF: 'v9' }).baseRef, 'v9');
	});

	test('a revision without packages/bb-auth-cognito is refused, naming the override and the default', () => {
		const problem = legacyPackageProblem(undefined, 'origin/main');
		assert.ok(problem);
		assert.match(problem, new RegExp(`origin/main has no ${LEGACY_PACKAGE_DIR}`));
		assert.match(problem, /--base-ref/);
		assert.ok(problem.includes(DEFAULT_BASE_REF));
	});

	test('the package must really be bb-auth-cognito', () => {
		assert.strictEqual(legacyPackageProblem({ name: LEGACY_PACKAGE_NAME, version: '0.1.10' }, 'r'), null);
		assert.match(
			legacyPackageProblem({ name: '@aws-blocks/bb-auth' }, 'r') ?? '',
			/not @aws-blocks\/bb-auth-cognito/,
		);
		assert.ok(legacyPackageProblem(null, 'r'));
		assert.ok(legacyPackageProblem('nope', 'r'));
	});
});

describe('upgradeRevisionErrors — the pair must be AuthCognito → Auth, never Auth → Auth', () => {
	/** `template` plus an `Auth` immutability guard at the stack root, as `Auth` synthesizes it. */
	const withGuard = (t: CfnTemplate): CfnTemplate => {
		t.Resources.BlocksAuthPoolGuard = {
			Type: AUTH_POOL_GUARD_TYPE,
			Metadata: { 'aws:cdk:path': `${STACK}/BlocksAuthPoolGuard/Default` },
		};
		return t;
	};

	test('AuthCognito before (no guard) and Auth after (guard): accepted', () => {
		assert.deepStrictEqual(upgradeRevisionErrors(template('auth-cognito'), withGuard(template('auth'))), []);
	});

	test('Auth on both sides (a post-cutover base revision) is refused — it would pass vacuously otherwise', () => {
		const before = withGuard(template('auth'));
		const after = withGuard(template('auth'));
		// The continuity check reports it too (the before side has no `sessions` table), but the
		// revision check is the one that names the cause.
		assert.match(compareContinuity(before, after).errors.join('\n'), /no 'sessions' resource/);
		const errors = upgradeRevisionErrors(before, after);
		assert.strictEqual(errors.length, 1);
		assert.match(errors[0], /BEFORE template has Auth's immutability guard/);
	});

	test('a BEFORE side with no user pool is refused', () => {
		const before = template('auth-cognito');
		delete before.Resources[POOL];
		assert.match(upgradeRevisionErrors(before, withGuard(template('auth'))).join('\n'), /no user pool/);
	});

	test('an AFTER side without the guard is refused (not synthesized by Auth)', () => {
		assert.match(
			upgradeRevisionErrors(template('auth-cognito'), template('auth')).join('\n'),
			/AFTER template has no Custom::BlocksAuthPoolGuard/,
		);
	});
});

describe('realModeRefusal — the real mode never runs by accident', () => {
	const ok = { [OPT_IN_ENV]: '1', AWS_REGION: 'us-east-1', AWS_PROFILE: 'sandbox' };

	test('runs only with the opt-in, a region and an explicit credential source', () => {
		assert.strictEqual(realModeRefusal(ok), null);
	});

	test('refuses without the opt-in (and only the exact value 1 opts in)', () => {
		for (const value of [undefined, '', '0', 'true', 'yes']) {
			const reason = realModeRefusal({ ...ok, [OPT_IN_ENV]: value });
			assert.match(reason ?? '', /BLOCKS_UPGRADE_E2E=1/);
		}
	});

	test('refuses without a region', () => {
		assert.match(realModeRefusal({ ...ok, AWS_REGION: undefined }) ?? '', /AWS_REGION/);
		assert.strictEqual(realModeRefusal({ ...ok, AWS_REGION: undefined, AWS_DEFAULT_REGION: 'eu-west-1' }), null);
	});

	test('refuses without credentials in the environment', () => {
		assert.match(realModeRefusal({ [OPT_IN_ENV]: '1', AWS_REGION: 'us-east-1' }) ?? '', /no AWS credentials/);
		// An access key alone is not a credential.
		assert.match(
			realModeRefusal({ [OPT_IN_ENV]: '1', AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'AKIA…' }) ?? '',
			/no AWS credentials/,
		);
	});

	test('accepts every explicit credential source', () => {
		const base = { [OPT_IN_ENV]: '1', AWS_REGION: 'us-east-1' };
		for (const creds of [
			{ AWS_PROFILE: 'p' },
			{ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's' },
			{ AWS_WEB_IDENTITY_TOKEN_FILE: '/t' },
			{ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials' },
			{ AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/creds' },
		]) {
			assert.strictEqual(realModeRefusal({ ...base, ...creds }), null, JSON.stringify(creds));
		}
	});
});

describe('offlineEnv — dry-run children cannot find a credential', () => {
	test('strips credential variables and the opt-in, points the SDK at nothing, keeps the rest', () => {
		const env = offlineEnv({
			PATH: '/usr/bin',
			AWS_PROFILE: 'admin',
			AWS_ACCESS_KEY_ID: 'a',
			AWS_SECRET_ACCESS_KEY: 's',
			AWS_SESSION_TOKEN: 't',
			AWS_REGION: 'us-east-1',
			[OPT_IN_ENV]: '1',
		});
		for (const key of [
			'AWS_PROFILE',
			'AWS_ACCESS_KEY_ID',
			'AWS_SECRET_ACCESS_KEY',
			'AWS_SESSION_TOKEN',
			OPT_IN_ENV,
		]) {
			assert.ok(!(key in env), key);
		}
		assert.strictEqual(env.PATH, '/usr/bin');
		assert.strictEqual(env.AWS_REGION, 'us-east-1');
		assert.match(env.AWS_CONFIG_FILE, /^\/nonexistent\//);
		assert.match(env.AWS_SHARED_CREDENTIALS_FILE, /^\/nonexistent\//);
		assert.strictEqual(env.AWS_EC2_METADATA_DISABLED, 'true');
	});
});

// ─────────────────────────────────────────────────────────────────────────────

describe('protectedResources', () => {
	test('finds the pool, client, group, sessions table and the session-secret in the recorded template', () => {
		const found = protectedResources(template('auth-cognito'));
		assert.deepStrictEqual(
			found.map((r) => [r.role, r.logicalId, r.type]),
			[
				['session-secret', 'BlocksSecretsBulk', 'AWS::CloudFormation::CustomResource'],
				['client', CLIENT, 'AWS::Cognito::UserPoolClient'],
				['group', 'upgradeauthgroupadmins538B4F84', 'AWS::Cognito::UserPoolGroup'],
				['pool', POOL, 'AWS::Cognito::UserPool'],
				['sessions', TABLE, 'AWS::DynamoDB::Table'],
			],
		);
		const byRole = Object.fromEntries(found.map((r) => [r.role, r.physicalName]));
		assert.strictEqual(byRole.pool, 'bb-test-upgrade-dryrun-upgrade-auth');
		assert.strictEqual(byRole.sessions, 'bb-test-upgrade-dryrun-upgrade-auth-sessions');
		assert.deepStrictEqual(byRole['session-secret'], ['/bb-test-upgrade-dryrun-upgrade-auth-session-secret']);
	});

	test('the Auth template has the session-store table, and no sessions table', () => {
		assert.deepStrictEqual(
			protectedResources(template('auth'))
				.filter((r) => r.type === 'AWS::DynamoDB::Table')
				.map((r) => [r.role, r.logicalId, r.physicalName]),
			[['session-store', STORE, 'bb-test-upgrade-dryrun-upgrade-auth-session-store']],
		);
	});

	test('ignores resources outside the block path', () => {
		assert.deepStrictEqual(
			protectedResources(template('auth-cognito'), 'some/other-block').map((r) => r.role),
			['session-secret'],
		);
	});
});

describe('compareContinuity', () => {
	test('recorded AuthCognito → Auth: pool, client and secret are kept; the sessions table is replaced by the session store', () => {
		const result = compareContinuity(template('auth-cognito'), template('auth'));
		assert.deepStrictEqual(result.errors, []);
		assert.ok(
			result.notes.some((n) => n.includes(POOL) && n.includes('DeletionProtection')),
			result.notes.join('\n'),
		);
		assert.strictEqual(result.legacySessions?.logicalId, TABLE);
		assert.strictEqual(result.sessionStore?.logicalId, STORE);
		assert.ok(
			result.notes.some((n) => n.startsWith(`REMOVED sessions ${TABLE}`) && n.includes('DeletionPolicy Delete')),
			result.notes.join('\n'),
		);
		assert.ok(
			result.notes.some((n) => n.startsWith(`ADDED session-store ${STORE}`)),
			result.notes.join('\n'),
		);
	});

	test('a renamed pool child id (pool → userPool) is REMOVED + ADDED', () => {
		const after = renameLogicalId(
			template('auth'),
			POOL,
			'upgradeauthuserPoolBDEC4D53',
			'bb-test-upgrade-dryrun/upgrade/auth/userPool/Resource',
		);
		const { errors } = compareContinuity(template('auth-cognito'), after);
		assert.ok(
			errors.some((e) => e.startsWith(`REMOVED pool ${POOL}`)),
			errors.join('\n'),
		);
		assert.ok(
			errors.some((e) => e.startsWith('ADDED pool upgradeauthuserPoolBDEC4D53')),
			errors.join('\n'),
		);
	});

	test('the session store: a sessions table that stays, no store, two stores, or a store with the old name is an error', () => {
		const kept = template('auth');
		kept.Resources[TABLE] = template('auth-cognito').Resources[TABLE];
		assert.match(
			compareContinuity(template('auth-cognito'), kept).errors.join('\n'),
			/KEPT sessions .* the deploy would fail/,
		);

		const noStore = template('auth');
		delete noStore.Resources[STORE];
		assert.match(
			compareContinuity(template('auth-cognito'), noStore).errors.join('\n'),
			/has 0 session-store table\(s\) .* expected exactly one/,
		);

		const twoStores = template('auth');
		twoStores.Resources.upgradeauthsessionstoretableSECOND = structuredClone(twoStores.Resources[STORE]);
		assert.match(
			compareContinuity(template('auth-cognito'), twoStores).errors.join('\n'),
			/has 2 session-store table\(s\)/,
		);

		const oldName = template('auth');
		oldName.Resources[STORE].Properties = {
			...oldName.Resources[STORE].Properties,
			TableName: 'bb-test-upgrade-dryrun-upgrade-auth-sessions',
		};
		const oldNameErrors = compareContinuity(template('auth-cognito'), oldName).errors.join('\n');
		assert.match(oldNameErrors, /has the name of the old sessions table/);
		assert.match(oldNameErrors, /does not end with '-session-store'/);

		const underOldChildId = renameLogicalId(
			template('auth'),
			STORE,
			'upgradeauthsessionstableNEW',
			'bb-test-upgrade-dryrun/upgrade/auth/sessions/table/Resource',
		);
		assert.match(
			compareContinuity(template('auth-cognito'), underOldChildId).errors.join('\n'),
			/ADDED sessions upgradeauthsessionstableNEW/,
		);
	});

	test('a removed or renamed secret resource is an error', () => {
		const noSecret = template('auth');
		delete noSecret.Resources.BlocksSecretsBulk;
		assert.match(compareContinuity(template('auth-cognito'), noSecret).errors.join('\n'), /REMOVED session-secret/);

		const otherSecret = template('auth');
		otherSecret.Resources.BlocksSecretsBulk.Properties = {
			...otherSecret.Resources.BlocksSecretsBulk.Properties,
			Parameters: [{ name: '/renamed-session-secret' }],
		};
		assert.match(
			compareContinuity(template('auth-cognito'), otherSecret).errors.join('\n'),
			/RENAMED session-secret/,
		);
	});

	test('a changed pool name or resource type is an error', () => {
		const renamed = template('auth');
		renamed.Resources[POOL].Properties = { ...renamed.Resources[POOL].Properties, UserPoolName: 'new-name' };
		assert.match(compareContinuity(template('auth-cognito'), renamed).errors.join('\n'), /RENAMED pool/);

		const retyped = template('auth');
		retyped.Resources[CLIENT].Type = 'AWS::Cognito::UserPoolResourceServer';
		assert.match(compareContinuity(template('auth-cognito'), retyped).errors.join('\n'), /TYPE CHANGED client/);
	});

	test('replace-only properties: client GenerateSecret / UserPoolId', () => {
		const secret = template('auth');
		secret.Resources[CLIENT].Properties = { ...secret.Resources[CLIENT].Properties, GenerateSecret: true };
		assert.match(
			compareContinuity(template('auth-cognito'), secret).errors.join('\n'),
			/GenerateSecret false → true — replace-only.*refresh token/,
		);

		const repointed = template('auth');
		repointed.Resources[CLIENT].Properties = {
			...repointed.Resources[CLIENT].Properties,
			UserPoolId: { Ref: 'X' },
		};
		assert.match(compareContinuity(template('auth-cognito'), repointed).errors.join('\n'), /client .* UserPoolId/);
	});

	test('service-immutable pool properties (the rollback-on-update trap) are errors', () => {
		for (const [key, value] of [
			['AliasAttributes', ['phone_number']],
			['UsernameAttributes', ['email']],
			['UsernameConfiguration', { CaseSensitive: true }],
		] as const) {
			const after = template('auth');
			after.Resources[POOL].Properties = { ...after.Resources[POOL].Properties, [key]: value };
			const { errors } = compareContinuity(template('auth-cognito'), after);
			assert.ok(
				errors.some((e) => e.includes(key) && e.includes('UpdateUserPool')),
				`${key}: ${errors.join('\n')}`,
			);
		}
	});

	test('schema: a changed or new required attribute is an error; a new optional one is not', () => {
		// BEFORE is the AuthCognito template, AFTER the Auth template, each with the given pool schema.
		const withSchema = (schema: unknown[], side: 'auth-cognito' | 'auth' = 'auth') => {
			const t = template(side);
			t.Resources[POOL].Properties = { ...t.Resources[POOL].Properties, Schema: schema };
			return t;
		};
		const before = withSchema([{ Name: 'tenant', AttributeDataType: 'String', Mutable: true }], 'auth-cognito');
		const changed = withSchema([{ Name: 'tenant', AttributeDataType: 'Number', Mutable: true }]);
		assert.match(compareContinuity(before, changed).errors.join('\n'), /schema attribute 'tenant'/);
		const removed = withSchema([]);
		assert.match(compareContinuity(before, removed).errors.join('\n'), /'tenant' removed/);
		const addedRequired = withSchema([
			{ Name: 'tenant', AttributeDataType: 'String', Mutable: true },
			{ Name: 'email', Required: true },
		]);
		assert.match(compareContinuity(before, addedRequired).errors.join('\n'), /new required attribute 'email'/);
		const addedOptional = withSchema([
			{ AttributeDataType: 'String', Mutable: true, Name: 'tenant' }, // key order must not matter
			{ Name: 'age', AttributeDataType: 'Number' },
		]);
		assert.deepStrictEqual(compareContinuity(before, addedOptional).errors, []);
	});

	test('a DeletionPolicy change and a new group are notes, not errors', () => {
		const after = template('auth');
		after.Resources[POOL].DeletionPolicy = 'Retain';
		after.Resources.upgradeauthgroupreaders1234 = {
			...after.Resources.upgradeauthgroupadmins538B4F84,
			Metadata: { 'aws:cdk:path': 'bb-test-upgrade-dryrun/upgrade/auth/group-readers' },
		};
		const result = compareContinuity(template('auth-cognito'), after);
		assert.deepStrictEqual(result.errors, []);
		assert.ok(
			result.notes.some((n) => n.includes('DeletionPolicy Delete → Retain')),
			result.notes.join('\n'),
		);
		assert.ok(result.notes.some((n) => n.startsWith('ADDED group upgradeauthgroupreaders1234')));
	});

	test('a pre-upgrade template without the auth block is reported, not silently passed', () => {
		const { errors } = compareContinuity({ Resources: {} }, template('auth'));
		for (const role of ['pool', 'client', 'sessions', 'session-secret']) {
			assert.ok(
				errors.some((e) => e.includes(`no '${role}' resource`)),
				role,
			);
		}
	});

	test('stableStringify ignores key order', () => {
		assert.strictEqual(
			stableStringify({ b: 1, a: [{ d: 2, c: 3 }] }),
			stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }),
		);
		assert.notStrictEqual(stableStringify([1, 2]), stableStringify([2, 1]));
	});
});

// ─────────────────────────────────────────────────────────────────────────────

describe('parseCdkDiff + findDiffViolations', () => {
	const protection = { types: DIFF_PROTECTED_TYPES, logicalIds: ['BlocksSecretsBulk'] };

	test('recorded clean AuthCognito → Auth diff: the pool is updated in place, nothing protected is replaced, and the sessions table is replaced by the session store', () => {
		const changes = parseCdkDiff(fixtureText('cdk-diff.clean.txt'));
		assert.deepStrictEqual(
			changes.map((c) => [c.action, c.type, c.logicalId, c.impact]),
			[
				['remove', 'AWS::DynamoDB::Table', TABLE, 'destroy'],
				['add', 'AWS::DynamoDB::Table', STORE, 'none'],
				['update', 'AWS::IAM::Policy', 'BlocksRoleDefaultPolicyF2F3EE2E', 'none'],
				['update', 'AWS::Lambda::Function', 'DefaultComputeHandlerF1C2C112', 'none'],
				['update', 'AWS::Cognito::UserPool', POOL, 'none'],
			],
		);
		assert.strictEqual(changes[4].path, 'upgrade/auth/pool');
		assert.deepStrictEqual(findDiffViolations(changes, protection), []);
		assert.deepStrictEqual(sessionStoreDiffErrors(changes, TABLE, STORE), []);
	});

	test('sessionStoreDiffErrors: a retained table leaves as orphan; a diff with no removal is reported', () => {
		const orphan = parseCdkDiff(
			[
				`[-] AWS::DynamoDB::Table upgrade/auth/sessions/table ${TABLE} orphan`,
				`[+] AWS::DynamoDB::Table upgrade/auth/session-store/table ${STORE}`,
			].join('\n'),
		);
		assert.deepStrictEqual(sessionStoreDiffErrors(orphan, TABLE, STORE), []);
		const none = sessionStoreDiffErrors([], TABLE, STORE);
		assert.strictEqual(none.length, 2, none.join('\n'));
		assert.match(none[0], /no change for the old sessions table/);
		assert.match(none[1], /does not add the session-store table/);
	});

	test('recorded diff with the pool child id renamed: DELETE + CREATE of the pool, client REPLACE', () => {
		const changes = parseCdkDiff(fixtureText('cdk-diff.pool-renamed.txt'));
		const client = changes.find((c) => c.logicalId === CLIENT);
		assert.strictEqual(client?.impact, 'replace');
		assert.deepStrictEqual(client?.replacingProperties, ['UserPoolId']);
		const violations = findDiffViolations(changes, protection);
		assert.strictEqual(violations.length, 3, violations.join('\n'));
		assert.match(violations[0], /^would DELETE AWS::Cognito::UserPool upgrade\/auth\/pool upgradeauthpool556377DE/);
		assert.match(violations[1], /^would CREATE a new AWS::Cognito::UserPool upgrade\/auth\/userPool/);
		assert.match(violations[2], /^would REPLACE AWS::Cognito::UserPoolClient .* via UserPoolId/);
	});

	test('strips ANSI color codes', () => {
		const colored =
			'\u001b[33m[~]\u001b[39m \u001b[36mAWS::Cognito::UserPool\u001b[39m upgrade/auth/pool \u001b[90mupgradeauthpool556377DE\u001b[39m \u001b[3m\u001b[1m\u001b[31mreplace\u001b[39m\u001b[22m\u001b[23m\n' +
			' └─ [~] UserPoolName (requires replacement)\n';
		const [c] = parseCdkDiff(colored);
		assert.deepStrictEqual(
			[c.action, c.logicalId, c.impact, c.replacingProperties],
			['update', POOL, 'replace', ['UserPoolName']],
		);
	});

	test("'may be replaced', '(may cause replacement)', orphan, no-path lines and move suffixes", () => {
		const text = [
			'Resources',
			`[~] AWS::Cognito::UserPoolClient ${CLIENT} may be replaced (OR move to other.${CLIENT} via refactoring)`,
			' └─ [~] ExplicitAuthFlows (may cause replacement)',
			`[-] AWS::Cognito::UserPool upgrade/auth/pool ${POOL} orphan`,
			`[~] AWS::DynamoDB::Table upgrade/auth/sessions/table ${TABLE} replace`,
			' ├─ [~] KeySchema (requires replacement)',
			' └─ [~] TableName (requires replacement)',
			'[+] Output ApiUrl ApiUrl: {"Value":"x"}',
		].join('\n');
		const changes = parseCdkDiff(text);
		assert.strictEqual(changes.length, 3);
		assert.deepStrictEqual(
			[changes[0].path, changes[0].logicalId, changes[0].impact],
			[undefined, CLIENT, 'may-replace'],
		);
		assert.deepStrictEqual(changes[0].replacingProperties, ['ExplicitAuthFlows']);
		assert.deepStrictEqual(changes[2].replacingProperties, ['KeySchema', 'TableName']);
		const v = findDiffViolations(changes, protection);
		assert.match(v[0], /^would REPLACE AWS::Cognito::UserPoolClient/);
		assert.match(v[1], /^would ORPHAN/);
		assert.strictEqual(v.length, 2);
		// A sessions table changed in place, with no session-store table added: the upgrade plan is not met.
		const storeErrors = sessionStoreDiffErrors(changes, TABLE, STORE);
		assert.strictEqual(storeErrors.length, 2, storeErrors.join('\n'));
		assert.match(storeErrors[0], /does not remove the old sessions table .* would fail the deploy/);
		assert.match(storeErrors[1], /does not add the session-store table/);
	});

	test('unprotected changes and IAM table rows are not violations', () => {
		const text = [
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal cdk diff output, not a template.
			'│ + │ ${upgradeauthpool556377DE.Arn} │ Allow │ cognito-idp:AdminListGroupsForUser │ AWS:${BlocksRole} │ │',
			'[-] AWS::Lambda::Function Old OldFn destroy',
			'[+] AWS::Cognito::UserPoolGroup upgrade/auth/group-readers upgradeauthgroupreaders1234',
		].join('\n');
		assert.deepStrictEqual(findDiffViolations(parseCdkDiff(text), protection), []);
	});

	test('"There were no differences" parses to nothing', () => {
		assert.deepStrictEqual(parseCdkDiff('Stack bb-test-upgrade-1\nThere were no differences\n'), []);
	});
});

// ─────────────────────────────────────────────────────────────────────────────

describe('classifyStackStatus', () => {
	test('classifies terminal and in-progress statuses', () => {
		const cases: Record<string, string> = {
			CREATE_COMPLETE: 'complete',
			UPDATE_COMPLETE: 'complete',
			UPDATE_ROLLBACK_COMPLETE: 'rolled-back',
			ROLLBACK_COMPLETE: 'rolled-back',
			UPDATE_IN_PROGRESS: 'in-progress',
			UPDATE_COMPLETE_CLEANUP_IN_PROGRESS: 'in-progress',
			UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS: 'in-progress',
			UPDATE_ROLLBACK_FAILED: 'failed',
			DELETE_FAILED: 'failed',
		};
		for (const [status, expected] of Object.entries(cases))
			assert.strictEqual(classifyStackStatus(status), expected, status);
	});
});

describe('extractUpdateFailures — surfacing the UpdateUserPool error', () => {
	test('rollback: the pool failure is the root cause; cascades and the EARLIER update are excluded', () => {
		const report = extractUpdateFailures(events('stack-events.update-rollback.json'), STACK);
		assert.strictEqual(report.finalStackStatus, 'UPDATE_ROLLBACK_COMPLETE');
		assert.strictEqual(report.updateStartedAt, '2026-10-03T10:10:00.000Z');
		assert.deepStrictEqual(
			report.failures.map((f) => [f.logicalId, f.status]),
			[[POOL, 'UPDATE_FAILED']],
		);
		assert.strictEqual(report.rootCause?.logicalId, POOL);
		assert.match(report.userPoolFailure?.reason ?? '', /Updates are not allowed for property - AliasAttributes/);
	});

	test('the input order does not matter (DescribeStackEvents is newest-first)', () => {
		const list = events('stack-events.update-rollback.json');
		const shuffled = [...list.slice(5), ...list.slice(0, 5)].reverse();
		assert.deepStrictEqual(extractUpdateFailures(shuffled, STACK), extractUpdateFailures(list, STACK));
	});

	test('a clean update reports no failures', () => {
		const report = extractUpdateFailures(events('stack-events.update-complete.json'), STACK);
		assert.strictEqual(report.finalStackStatus, 'UPDATE_COMPLETE');
		assert.deepStrictEqual(report.failures, []);
		assert.strictEqual(report.userPoolFailure, undefined);
	});

	test('without an update in the events, every failure counts', () => {
		const createOnly: StackEventLike[] = [
			{
				LogicalResourceId: STACK,
				ResourceType: 'AWS::CloudFormation::Stack',
				ResourceStatus: 'CREATE_IN_PROGRESS',
				Timestamp: '2026-10-03T10:00:00Z',
			},
			{
				LogicalResourceId: POOL,
				ResourceType: 'AWS::Cognito::UserPool',
				ResourceStatus: 'CREATE_FAILED',
				ResourceStatusReason: 'boom',
				Timestamp: '2026-10-03T10:00:05Z',
			},
			{
				LogicalResourceId: STACK,
				ResourceType: 'AWS::CloudFormation::Stack',
				ResourceStatus: 'ROLLBACK_COMPLETE',
				Timestamp: '2026-10-03T10:01:00Z',
			},
		];
		const report = extractUpdateFailures(createOnly, STACK);
		assert.strictEqual(report.updateStartedAt, undefined);
		assert.strictEqual(report.finalStackStatus, 'ROLLBACK_COMPLETE');
		assert.strictEqual(report.userPoolFailure?.reason, 'boom');
	});

	test('the formatted report leads with the UpdateUserPool error', () => {
		const text = formatUpdateFailureReport(
			extractUpdateFailures(events('stack-events.update-rollback.json'), STACK),
			STACK,
		);
		const lines = text.split('\n');
		assert.match(lines[0], /did not reach UPDATE_COMPLETE \(latest status: UPDATE_ROLLBACK_COMPLETE\)/);
		assert.match(text, /UpdateUserPool rejected the change[\s\S]*AliasAttributes/);
		assert.ok(!text.includes('Code storage limit'), 'an earlier update must not be blamed');
		assert.ok(!text.includes('Resource update cancelled'), 'cascades are omitted');
	});
});

// ─────────────────────────────────────────────────────────────────────────────

describe('compareDeployedIdentity', () => {
	const before: DeployedIdentity = {
		userPoolId: 'us-east-1_AbCdEf123',
		clientId: '1a2b3c4d5e6f7g8h9i0j',
		sessionsTableName: 'bb-test-upgrade-1-1-upgrade-auth-sessions',
		sessionSecretParameterName: '/bb-test-upgrade-1-1-upgrade-auth-session-secret',
	};
	const after: DeployedIdentity = {
		...before,
		sessionsTableName: 'bb-test-upgrade-1-1-upgrade-auth-session-store',
	};

	test('pool, client and secret kept, sessions in the new session-store table → no problems', () => {
		assert.deepStrictEqual(compareDeployedIdentity(before, after), []);
	});

	test('a changed pool, client or secret is reported', () => {
		const diff = compareDeployedIdentity(before, {
			...after,
			userPoolId: 'us-east-1_New',
			sessionSecretParameterName: '/other',
		});
		assert.deepStrictEqual(diff, [
			'user pool id changed: us-east-1_AbCdEf123 → us-east-1_New',
			'session-secret SSM parameter name changed: /bb-test-upgrade-1-1-upgrade-auth-session-secret → /other',
		]);
	});

	test('sessions still in the old table, or a new table with another name, is reported', () => {
		assert.deepStrictEqual(compareDeployedIdentity(before, { ...before }), [
			'the sessions are still in the table bb-test-upgrade-1-1-upgrade-auth-sessions: expected a new table for the session store',
			'the session-store table name bb-test-upgrade-1-1-upgrade-auth-sessions does not end with -session-store',
		]);
		assert.deepStrictEqual(compareDeployedIdentity(before, { ...after, sessionsTableName: 'other' }), [
			'the session-store table name other does not end with -session-store',
		]);
	});
});

describe('removalOutcome — how the old sessions table left the stack', () => {
	const event = (status: string, id = TABLE): StackEventLike => ({ LogicalResourceId: id, ResourceStatus: status });

	test('DELETE_COMPLETE → deleted (a Delete policy: what the harness app deploys with)', () => {
		const stackEvents = [event('CREATE_COMPLETE'), event('DELETE_IN_PROGRESS'), event('DELETE_COMPLETE')];
		assert.strictEqual(removalOutcome(stackEvents, TABLE), 'deleted');
	});

	test('DELETE_SKIPPED → retained (a Retain policy: the table stays in the account, outside the stack)', () => {
		assert.strictEqual(removalOutcome([event('CREATE_COMPLETE'), event('DELETE_SKIPPED')], TABLE), 'retained');
	});

	test('DELETE_FAILED → failed; no delete event, or events of another resource → unknown', () => {
		assert.strictEqual(removalOutcome([event('DELETE_FAILED')], TABLE), 'failed');
		assert.strictEqual(removalOutcome([event('CREATE_COMPLETE')], TABLE), 'unknown');
		assert.strictEqual(removalOutcome([event('DELETE_COMPLETE', POOL)], TABLE), 'unknown');
	});
});

describe('HARNESS_AWS_ACTIONS', () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const harness = readFileSync(join(here, '..', 'upgrade-in-place.ts'), 'utf8');
	/** IAM service prefix per SDK client package. A new client must be added here (and to the CI role). */
	const IAM_PREFIX: Record<string, string> = {
		'client-cloudformation': 'cloudformation',
		'client-cognito-identity-provider': 'cognito-idp',
		'client-sts': 'sts',
	};
	const aliases = new Map(
		[...harness.matchAll(/const (\w+) = await import\('@aws-sdk\/([\w-]+)'\)/g)].map(([, alias, pkg]) => {
			assert.ok(IAM_PREFIX[pkg], `no IAM prefix for @aws-sdk/${pkg}`);
			return [alias, IAM_PREFIX[pkg]];
		}),
	);
	const sent = new Set(
		[...harness.matchAll(/\b(\w+)\.(?:paginate(\w+)\(|(\w+)Command\()/g)].map(([, alias, paged, command]) => {
			const prefix = aliases.get(alias);
			assert.ok(prefix, `'${alias}' is not an @aws-sdk client import`);
			return `${prefix}:${paged ?? command}`;
		}),
	);

	test('every SDK command the harness sends is listed, and nothing else', () => {
		assert.ok(sent.size > 0, 'found no SDK commands in upgrade-in-place.ts');
		assert.deepStrictEqual([...sent].sort(), [...HARNESS_AWS_ACTIONS].sort());
	});

	test('the harness header comment lists every action', () => {
		const header = harness.slice(0, harness.indexOf('*/'));
		for (const action of HARNESS_AWS_ACTIONS) assert.ok(header.includes(action), `header misses ${action}`);
	});

	test('every IAM-authorized action is granted to the CI e2e role (test-infra/github-oidc-stack.ts)', () => {
		const role = readFileSync(join(here, '../../../../test-infra/github-oidc-stack.ts'), 'utf8');
		const granted = (a: string) => UNAUTHENTICATED_AWS_ACTIONS.includes(a) || role.includes(`'${a}'`);
		assert.deepStrictEqual(HARNESS_AWS_ACTIONS.filter((a) => !granted(a)), []);
	});
});

describe('JSON-RPC and the session cookie', () => {
	test('encodeRpcRequest targets <namespace>.<method> with positional params', () => {
		assert.deepStrictEqual(JSON.parse(encodeRpcRequest('api', 'signIn', ['u', 'p'], 7)), {
			jsonrpc: '2.0',
			method: 'api.signIn',
			params: ['u', 'p'],
			id: 7,
		});
	});

	test('decodeRpcResponse: result, error with name, error without name, garbage', () => {
		assert.deepStrictEqual(decodeRpcResponse({ jsonrpc: '2.0', result: { ok: 1 }, id: 1 }), {
			ok: true,
			result: { ok: 1 },
		});
		assert.deepStrictEqual(
			decodeRpcResponse({
				error: { code: 401, message: 'Authentication required', data: { name: 'NotAuthenticatedException' } },
			}),
			{ ok: false, code: 401, message: 'Authentication required', name: 'NotAuthenticatedException' },
		);
		assert.deepStrictEqual(decodeRpcResponse({ error: { code: 501, message: 'not implemented' } }), {
			ok: false,
			code: 501,
			message: 'not implemented',
		});
		assert.strictEqual(decodeRpcResponse(null).ok, false);
	});

	test('clearsCookie: true only for a line that deletes exactly that cookie', () => {
		const cleared = ['auth_app-auth=; Max-Age=0; Path=/; HttpOnly'];
		assert.strictEqual(clearsCookie(cleared, 'auth_app-auth'), true);
		assert.strictEqual(clearsCookie(cleared, 'auth_app'), false);
		assert.strictEqual(clearsCookie(['auth_app-auth=abc.def; Max-Age=3600; Path=/'], 'auth_app-auth'), false);
		assert.strictEqual(
			clearsCookie(['auth_app-auth=; Expires=Thu, 01 Jan 1970 00:00:00 GMT'], 'auth_app-auth'),
			true,
		);
		assert.strictEqual(clearsCookie([], 'auth_app-auth'), false);
	});

	test('extractSessionCookie picks the live auth_<fullId> cookie and skips deletions', () => {
		const now = Date.parse('2026-10-03T12:00:00Z');
		assert.deepStrictEqual(
			extractSessionCookie(
				[
					'other=1; Path=/',
					'auth_old=; Max-Age=0; Path=/',
					'auth_stale=v; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
					'auth_bb-test-upgrade-1-1-upgrade-auth=s%3Aabc.def==; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000',
				],
				now,
			),
			{ name: 'auth_bb-test-upgrade-1-1-upgrade-auth', value: 's%3Aabc.def==' },
		);
		assert.strictEqual(extractSessionCookie(['auth_x=v; Max-Age=0'], now), null);
		assert.strictEqual(extractSessionCookie([], now), null);
	});
});
