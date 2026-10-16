// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The comprehensive app's test-only RPCs (`testSupport`: account creation, the
 * `authC.admin` surface, a secret setting's value, the delivered-code sweep)
 * and the Admin* IAM behind them exist only on an e2e build. This proves it on
 * the synthesized stack, offline: a normal synth registers none of the methods
 * (neither in `testSupport` nor back in `api`), records no `testSupport`
 * namespace, grants no admin-surface `cognito-idp` action on any pool, and
 * declares no test-support secret. The e2e synth (`BLOCKS_TEST_ENV=sandbox`)
 * registers exactly `TEST_SUPPORT_METHODS` and grants admin only on the pools
 * those methods use.
 *
 * Each synth runs in its own process (`test-support-synth.probe.ts`, under
 * `--conditions=cdk`), because the flag is read when the backend module loads.
 */

import { before, describe, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_SUPPORT_METHODS } from './test-support.js';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `cognito-idp` actions only the `admin` surface grants (bb-auth's
 * `adminIamActions`). `AdminListGroupsForUser` is left out: every pool with
 * groups gets it for `requireRole`'s live membership read.
 */
const ADMIN_LIFECYCLE = [
	'cognito-idp:AdminCreateUser',
	'cognito-idp:AdminDeleteUser',
	'cognito-idp:AdminEnableUser',
	'cognito-idp:AdminDisableUser',
	'cognito-idp:AdminResetUserPassword',
	'cognito-idp:AdminSetUserPassword',
	'cognito-idp:AdminGetUser',
	'cognito-idp:ListUsers',
	'cognito-idp:AdminUserGlobalSignOut',
];
const ADMIN_GROUPS = ['cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup', 'cognito-idp:ListUsersInGroup'];
const ADMIN_SURFACE = new Set([...ADMIN_LIFECYCLE, ...ADMIN_GROUPS]);

interface CfnResource {
	Type: string;
	Properties?: Record<string, unknown>;
}

interface ProbeResult {
	apiMethods: string[] | null;
	testSupportMethods: string[] | null;
	namespaces: string[];
	template: { Resources: Record<string, CfnResource>; Outputs?: Record<string, unknown> };
}

/** Synthesize the stack in a fresh `--conditions=cdk` process and return the probe's summary. */
function synth(testEnv: string | undefined): ProbeResult {
	const dir = mkdtempSync(join(tmpdir(), 'test-support-synth-'));
	try {
		const out = join(dir, 'probe.json');
		const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '', CDK_CONTEXT_JSON: JSON.stringify({ sandboxMode: 'true' }) };
		delete env.BLOCKS_TEST_ENV;
		if (testEnv) env.BLOCKS_TEST_ENV = testEnv;
		execFileSync('npx', ['tsx', '-C', 'cdk', 'test/test-support-synth.probe.ts', out], { cwd: APP_ROOT, env, stdio: 'pipe' });
		return JSON.parse(readFileSync(out, 'utf-8'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Admin-surface actions granted per resource logical id (`Fn::GetAtt [id, 'Arn']`), across every IAM policy. */
function adminGrants(template: ProbeResult['template']): Map<string, Set<string>> {
	const grants = new Map<string, Set<string>>();
	const statements = Object.values(template.Resources).flatMap((r) => {
		if (r.Type !== 'AWS::IAM::Policy' && r.Type !== 'AWS::IAM::ManagedPolicy' && r.Type !== 'AWS::IAM::Role') return [];
		const docs = [r.Properties?.PolicyDocument, ...asArray(r.Properties?.Policies).map((p) => field(p, 'PolicyDocument'))];
		return docs.flatMap((doc) => asArray(field(doc, 'Statement')));
	});
	for (const statement of statements) {
		const actions = asArray(field(statement, 'Action')).filter((a): a is string => typeof a === 'string');
		const admin = actions.filter((a) => ADMIN_SURFACE.has(a));
		if (admin.length === 0) continue;
		for (const resource of asArray(field(statement, 'Resource'))) {
			const getAtt = asArray(field(resource, 'Fn::GetAtt'));
			const id = typeof getAtt[0] === 'string' ? getAtt[0] : JSON.stringify(resource);
			const set = grants.get(id) ?? new Set<string>();
			for (const a of admin) set.add(a);
			grants.set(id, set);
		}
	}
	return grants;
}

/** The logical id of the user pool of the `Auth` block `blockId` (CDK path `test-app/<blockId>/pool`). */
function poolId(template: ProbeResult['template'], blockId: string): string {
	const pattern = new RegExp(`^testapp${blockId.replace(/-/g, '')}pool[0-9A-F]{8}$`);
	const ids = Object.entries(template.Resources)
		.filter(([id, r]) => r.Type === 'AWS::Cognito::UserPool' && pattern.test(id))
		.map(([id]) => id);
	assert.strictEqual(ids.length, 1, `expected one user pool for ${blockId}, found ${JSON.stringify(ids)}`);
	return ids[0];
}

function asArray(value: unknown): unknown[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

function field(value: unknown, key: string): unknown {
	return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

/** The ungated `api.*` names these methods had before they were gated. */
const LEGACY_API_NAMES: readonly string[] = TEST_SUPPORT_METHODS.map((m) => (m === 'provisionUser' ? 'authProvisionUser' : m));

describe('comprehensive test support: normal synth vs e2e synth', () => {
	let normal: ProbeResult;
	let e2e: ProbeResult;

	before(() => {
		normal = synth(undefined);
		e2e = synth('sandbox');
	});

	describe('normal synth (no BLOCKS_TEST_ENV)', () => {
		test('registers no testSupport namespace', () => {
			assert.strictEqual(normal.testSupportMethods, null);
			assert.ok(!normal.namespaces.includes('testSupport'), `namespaces: ${JSON.stringify(normal.namespaces)}`);
		});

		test('none of the test-only methods is on api either', () => {
			assert.ok(normal.apiMethods && normal.apiMethods.length > 0, 'expected the api namespace to load');
			const leaked = normal.apiMethods.filter((m) => LEGACY_API_NAMES.includes(m));
			assert.deepStrictEqual(leaked, []);
		});

		test('grants no admin-surface cognito-idp action on any resource', () => {
			const grants = Object.fromEntries([...adminGrants(normal.template)].map(([id, s]) => [id, [...s].sort()]));
			assert.deepStrictEqual(grants, {});
		});

		test('declares no test-support secret, output or handler flag', () => {
			const json = JSON.stringify(normal.template);
			assert.ok(!json.includes('test-support-secret'), 'the test-support-secret AppSetting is synthesized');
			assert.ok(!('TestSupportSecretParameter' in (normal.template.Outputs ?? {})), 'TestSupportSecretParameter output');
			assert.ok(!json.includes('BLOCKS_TEST_ENV'), 'BLOCKS_TEST_ENV reaches the handler');
		});
	});

	describe('e2e synth (BLOCKS_TEST_ENV=sandbox)', () => {
		test('registers exactly the gated testSupport methods, and none on api', () => {
			assert.deepStrictEqual(e2e.testSupportMethods, [...TEST_SUPPORT_METHODS].sort());
			assert.ok(e2e.namespaces.includes('testSupport'), `namespaces: ${JSON.stringify(e2e.namespaces)}`);
			assert.deepStrictEqual(
				(e2e.apiMethods ?? []).filter((m) => LEGACY_API_NAMES.includes(m)),
				[],
			);
		});

		test('grants admin only on the pools testSupport drives', () => {
			const t = e2e.template;
			const grants = Object.fromEntries([...adminGrants(t)].map(([id, s]) => [id, [...s].sort()]));
			assert.deepStrictEqual(grants, {
				[poolId(t, 'auth')]: [...ADMIN_LIFECYCLE].sort(),
				[poolId(t, 'auth-same-origin')]: [...ADMIN_LIFECYCLE].sort(),
				[poolId(t, 'auth-cross-domain')]: [...ADMIN_LIFECYCLE].sort(),
				[poolId(t, 'authC')]: [...ADMIN_LIFECYCLE, ...ADMIN_GROUPS].sort(),
			});
		});

		test('outputs the secret parameter name and forwards the flag to the handler', () => {
			assert.ok('TestSupportSecretParameter' in (e2e.template.Outputs ?? {}));
			assert.ok(JSON.stringify(e2e.template).includes('BLOCKS_TEST_ENV'));
		});
	});
});
