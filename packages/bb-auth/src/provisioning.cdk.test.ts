// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What `Auth` provisions per configuration (decision Q6) and how the pool's
 * durability follows the stack defaults (decision Q4). Real synth under
 * `--conditions=cdk` (see `test-support/cdk-synth.ts`).
 *
 * Q6: a configuration with no pool-backed sign-in method — no email + password,
 * no social or SAML provider, no `federateVia: 'cognito'` OIDC provider —
 * synthesizes no Cognito resources, only `sessions` and `session-secret`.
 * Enabling one later must create `pool` / `client` under the frozen ids:
 * additive, never a replacement.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { federationConfigKeys } from './cdk/contract.js';
import type { CfnResourceJson, CfnTemplateJson } from './test-support/cdk-synth.js';
import {
	BLOCK_PATH_PREFIX,
	diffIdentity,
	expectedConfigKeys,
	type SynthesizedAuth,
	synthIdentity,
	type VariantIdentity,
} from './test-support/identity.js';

const FIXTURE_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'src',
	'__fixtures__',
	'authcognito-resource-identity.json',
);
const FIXTURE_DEFAULT = (
	JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { variants: Record<string, VariantIdentity> }
).variants.default;

/**
 * A provider secret: a real stack-level `secret: true` AppSetting (the CDK layer
 * refuses anything it cannot prove lives at `/<fullId>`). It joins the shared
 * `BlocksSecretsBulk` parameter list as `/TestStack-idp-secret`.
 */
const SECRET = "new AppSetting(stack, 'idp-secret', { secret: true })";
const TEST_SECRET_PARAMETER = '/TestStack-idp-secret';
const OKTA_DIRECT = "okta: { issuer: 'https://dev-1.okta.com', clientId: '0oa1' }";

const CONFIGS = {
	default: "new Auth(stack, 'auth')",
	directOnly: `new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { ${OKTA_DIRECT} }, users: { groups: ['admins'] } })`,
	socialOnly: `new Auth(stack, 'auth', { emailPassword: false, socialProviders: { google: { clientId: 'g-client', clientSecret: ${SECRET} } } })`,
	samlOnly: `new Auth(stack, 'auth', { emailPassword: false, samlProviders: { corp: { metadataUrl: 'https://idp.example.com/metadata' } } })`,
	cognitoOidcOnly: `new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { okta: { issuer: 'https://dev-1.okta.com', clientId: '0oa1', clientSecret: ${SECRET}, federateVia: 'cognito' } } })`,
	mixed: `new Auth(stack, 'auth', { oidcProviders: { ${OKTA_DIRECT} }, socialProviders: { google: { clientId: 'g-client', clientSecret: ${SECRET} } }, users: { groups: ['admins'] } })`,
	directThenEmailPassword: `new Auth(stack, 'auth', { oidcProviders: { ${OKTA_DIRECT} } })`,
} as const;

const cache: Record<string, SynthesizedAuth> = {};
function synth(construct: string, preset?: 'sandbox' | 'production'): SynthesizedAuth {
	const key = `${preset ?? ''}|${construct}`;
	cache[key] ??= synthIdentity(construct, preset);
	return cache[key];
}

function cognitoResources(template: CfnTemplateJson): string[] {
	return Object.entries(template.Resources)
		.filter(([, r]) => r.Type.startsWith('AWS::Cognito::'))
		.map(([id, r]) => `${id} (${r.Type})`);
}

function cognitoIamActions(template: CfnTemplateJson): string[] {
	const actions: string[] = [];
	for (const r of Object.values(template.Resources)) {
		if (r.Type !== 'AWS::IAM::Policy') continue;
		const doc = r.Properties?.PolicyDocument as { Statement: { Action: string | string[] }[] };
		for (const s of doc.Statement) {
			for (const a of [s.Action].flat()) if (a.startsWith('cognito-idp:')) actions.push(a);
		}
	}
	return actions;
}

function only(template: CfnTemplateJson, type: string): CfnResourceJson {
	const found = Object.values(template.Resources).filter((r) => r.Type === type);
	assert.strictEqual(found.length, 1, `expected exactly one ${type}`);
	return found[0];
}

function poolOf(template: CfnTemplateJson): CfnResourceJson {
	return only(template, 'AWS::Cognito::UserPool');
}

function sessionsTableOf(template: CfnTemplateJson): CfnResourceJson {
	const table = Object.values(template.Resources).find(
		(r) => r.Metadata?.['aws:cdk:path'] === `${BLOCK_PATH_PREFIX}sessions/table/Resource`,
	);
	assert.ok(table, 'sessions table is missing');
	return table;
}

const removalWarnings = (s: SynthesizedAuth) =>
	s.warnings.filter((w) => w.message.includes('@aws-blocks/bb-auth:RemovalPolicyUnset'));

describe('Auth — Q6 conditional provisioning', () => {
	test('default: pool, client, sessions and session-secret (the AuthCognito identity)', () => {
		const { identity } = synth(CONFIGS.default);
		assert.deepStrictEqual(diffIdentity(FIXTURE_DEFAULT, identity), []);
	});

	describe('direct-OIDC-only: no Cognito resources at all', () => {
		test('synthesizes no AWS::Cognito::* resource (not even the declared groups)', () => {
			assert.deepStrictEqual(cognitoResources(synth(CONFIGS.directOnly).template), []);
		});

		test('provisions exactly `sessions` and `session-secret`', () => {
			const { identity } = synth(CONFIGS.directOnly);
			assert.deepStrictEqual(identity.resources, {
				authsessionstable46C26735: FIXTURE_DEFAULT.resources.authsessionstable46C26735,
				BlocksSecretsBulk: FIXTURE_DEFAULT.resources.BlocksSecretsBulk,
			});
		});

		test('registers no BLOCKS_AUTH_COGNITO_* config key and grants no cognito-idp action', () => {
			const s = synth(CONFIGS.directOnly);
			assert.deepStrictEqual(s.identity.configKeys, {});
			assert.deepStrictEqual(cognitoIamActions(s.template), []);
		});

		test('does not warn about removalPolicy (there is no pool to lose)', () => {
			assert.deepStrictEqual(removalWarnings(synth(CONFIGS.directOnly)), []);
		});
	});

	for (const name of ['socialOnly', 'samlOnly', 'cognitoOidcOnly'] as const) {
		describe(`${name}: provisions the pool (hosted-UI federation needs it)`, () => {
			test('pool and client exist under the frozen logical ids; federation only adds', () => {
				const { identity } = synth(CONFIGS[name]);
				// The test's own provider secret (not the block's) joins the shared
				// bulk-secret list; pin exactly that and nothing else about it.
				const bulk = FIXTURE_DEFAULT.resources.BlocksSecretsBulk;
				const usesSecret = name !== 'samlOnly';
				const expectedBulkNames = usesSecret
					? [...[bulk.physicalName].flat(), TEST_SECRET_PARAMETER].sort()
					: bulk.physicalName;
				assert.deepStrictEqual(identity.resources.BlocksSecretsBulk?.physicalName, expectedBulkNames);
				const diff = diffIdentity(FIXTURE_DEFAULT, {
					...identity,
					resources: { ...identity.resources, BlocksSecretsBulk: bulk },
				});
				// Every fixture resource and config key survives unchanged…
				assert.deepStrictEqual(
					diff.filter((line) => !line.startsWith('+')),
					[],
				);
				// …and what D3b adds is the federation infrastructure (federation.cdk.test.ts
				// pins it resource by resource) plus exactly the two federation config keys.
				const keys = federationConfigKeys(identity.fullId);
				assert.deepStrictEqual(
					diff.filter((line) => line.startsWith('+ new config key')).map((line) => line.split(' ')[4]),
					[keys.DOMAIN, keys.HOSTED_UI_CLIENT_ID],
				);
				for (const line of diff.filter((l) => l.startsWith('+ ADDED'))) {
					assert.match(
						line,
						/construct path TestStack\/auth\/(domain|hosted-ui-client|idp-|saml-)/,
						`unexpected addition: ${line}`,
					);
				}
			});

			test('self-service sign-up is off (`emailPassword: false`)', () => {
				const props = poolOf(synth(CONFIGS[name]).template).Properties;
				assert.deepStrictEqual(props?.AdminCreateUserConfig, { AllowAdminCreateUserOnly: true });
			});

			test('config keys (pool + federation) and the base IAM statement are present', () => {
				const s = synth(CONFIGS[name]);
				assert.deepStrictEqual(
					Object.keys(s.identity.configKeys).sort(),
					[
						...expectedConfigKeys(s.identity.fullId),
						...Object.values(federationConfigKeys(s.identity.fullId)),
					].sort(),
				);
				assert.ok(cognitoIamActions(s.template).includes('cognito-idp:AdminListGroupsForUser'));
			});
		});
	}

	describe('mixed (email + password, direct OIDC, social)', () => {
		test('pool, client and the declared group under the frozen ids', () => {
			const { identity } = synth(CONFIGS.mixed);
			const paths = Object.values(identity.resources).map((r) => r.path);
			for (const p of ['pool/Resource', 'client/Resource', 'group-admins', 'sessions/table/Resource']) {
				assert.ok(paths.includes(`${BLOCK_PATH_PREFIX}${p}`), `missing ${p}`);
			}
			assert.ok(identity.resources.authpoolBA1CDCB6, 'pool logical id is the frozen one');
			assert.ok(identity.resources.authclientB98ED767, 'client logical id is the frozen one');
		});

		test('self-service sign-up stays on (email + password is enabled)', () => {
			const props = poolOf(synth(CONFIGS.mixed).template).Properties;
			assert.deepStrictEqual(props?.AdminCreateUserConfig, { AllowAdminCreateUserOnly: false });
		});
	});

	test('direct-only, then enabling email + password, is additive and lands on the frozen ids', () => {
		const before = synth(CONFIGS.directOnly).identity;
		const after = synth(CONFIGS.directThenEmailPassword).identity;
		// Additive: nothing that existed is removed or changed…
		for (const [id, r] of Object.entries(before.resources)) {
			assert.deepStrictEqual(after.resources[id], r, `${id} must survive unchanged`);
		}
		// …and what is added is exactly AuthCognito's pool + client (same logical ids,
		// paths and names), so the result is indistinguishable from the default.
		assert.deepStrictEqual(diffIdentity(FIXTURE_DEFAULT, after), []);
		const added = Object.keys(after.resources).filter((id) => !(id in before.resources));
		assert.deepStrictEqual(added.sort(), ['authclientB98ED767', 'authpoolBA1CDCB6']);
	});
});

describe('Auth — Q4 pool durability follows the stack defaults', () => {
	describe('BlocksPresets.sandbox', () => {
		test('removalPolicy unset → pool Delete, DeletionProtection omitted (inactive, as AuthCognito); sessions follow too', () => {
			const { template } = synth(CONFIGS.default, 'sandbox');
			const pool = poolOf(template);
			assert.strictEqual(pool.DeletionPolicy, 'Delete');
			assert.strictEqual(pool.UpdateReplacePolicy, 'Delete');
			// L20: only ACTIVE is emitted; unset is Cognito's default (inactive).
			assert.ok(!('DeletionProtection' in (pool.Properties ?? {})));
			const table = sessionsTableOf(template);
			assert.strictEqual(table.DeletionPolicy, 'Delete');
			assert.strictEqual(table.Properties?.DeletionProtectionEnabled, false);
		});

		test('removalPolicy unset → warns at synth, naming the resolved default', () => {
			const warnings = removalWarnings(synth(CONFIGS.default, 'sandbox'));
			assert.strictEqual(warnings.length, 1);
			assert.strictEqual(warnings[0].path, '/TestStack/auth');
			assert.match(warnings[0].message, /follows the stack default \('destroy'\)/);
		});

		test("explicit removalPolicy: 'retain' + deletionProtection: true win over the preset, and do not warn", () => {
			const s = synth(
				"new Auth(stack, 'auth', { removalPolicy: 'retain', deletionProtection: true })",
				'sandbox',
			);
			const pool = poolOf(s.template);
			assert.strictEqual(pool.DeletionPolicy, 'Retain');
			assert.strictEqual(pool.Properties?.DeletionProtection, 'ACTIVE');
			const table = sessionsTableOf(s.template);
			assert.strictEqual(table.DeletionPolicy, 'Retain');
			assert.strictEqual(table.Properties?.DeletionProtectionEnabled, true);
			assert.deepStrictEqual(removalWarnings(s), []);
		});
	});

	describe('BlocksPresets.production', () => {
		test('removalPolicy unset → pool Retain + DeletionProtection ACTIVE (AuthCognito: Delete); sessions follow too', () => {
			const { template } = synth(CONFIGS.default, 'production');
			const pool = poolOf(template);
			assert.strictEqual(pool.DeletionPolicy, 'Retain');
			assert.strictEqual(pool.UpdateReplacePolicy, 'Retain');
			assert.strictEqual(pool.Properties?.DeletionProtection, 'ACTIVE');
			const table = sessionsTableOf(template);
			assert.strictEqual(table.DeletionPolicy, 'Retain');
			assert.strictEqual(table.Properties?.DeletionProtectionEnabled, true);
		});

		test('removalPolicy unset → warns at synth, naming the resolved default', () => {
			const warnings = removalWarnings(synth(CONFIGS.default, 'production'));
			assert.strictEqual(warnings.length, 1);
			assert.match(warnings[0].message, /follows the stack default \('retain'\)/);
		});

		test("explicit removalPolicy: 'destroy' + deletionProtection: false win over the preset, and do not warn", () => {
			const s = synth(
				"new Auth(stack, 'auth', { removalPolicy: 'destroy', deletionProtection: false })",
				'production',
			);
			const pool = poolOf(s.template);
			assert.strictEqual(pool.DeletionPolicy, 'Delete');
			// L20: `false` omits the property rather than emitting INACTIVE.
			assert.ok(!('DeletionProtection' in (pool.Properties ?? {})));
			const table = sessionsTableOf(s.template);
			assert.strictEqual(table.DeletionPolicy, 'Delete');
			assert.strictEqual(table.Properties?.DeletionProtectionEnabled, false);
			assert.deepStrictEqual(removalWarnings(s), []);
		});

		test('a direct-only config (no pool) and a wrapped existing pool do not warn', () => {
			assert.deepStrictEqual(removalWarnings(synth(CONFIGS.directOnly, 'production')), []);
			const existing = synth(
				"new Auth(stack, 'auth', { userPool: Auth.fromExisting('us-east-1_existing') })",
				'production',
			);
			assert.deepStrictEqual(removalWarnings(existing), []);
		});
	});

	test('identity is unchanged by the preset (Q4 touches durability only)', () => {
		for (const preset of ['sandbox', 'production'] as const) {
			assert.deepStrictEqual(diffIdentity(FIXTURE_DEFAULT, synth(CONFIGS.default, preset).identity), [], preset);
		}
	});
});
