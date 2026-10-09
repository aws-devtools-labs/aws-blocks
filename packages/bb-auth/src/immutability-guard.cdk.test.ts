// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * THE IMMUTABILITY GUARD (task D4, decision Q5), end to end without AWS.
 *
 * Four user-pool properties are immutable at the Cognito service level while
 * CloudFormation calls them "No interruption": a change synths, `cdk diff`
 * looks harmless, and the deploy rolls the whole stack back. `Auth` refuses
 * such a change twice:
 *
 * 1. at synth, against the committed baseline file (real synth here, under
 *    `--conditions=cdk`, in a throwaway app directory), and
 * 2. at deploy, in a custom resource every pool depends on (its handler is
 *    driven here with the `Pools` property of the *synthesized* templates and
 *    stubbed CloudFormation / Cognito clients — no network).
 *
 * A false positive blocks a legitimate deploy, which is worse than no guard.
 * So every PERMITTED change below must pass BOTH layers, and every GUARDED
 * one must fail both (pool removal: layer 1 only — see DESIGN.md).
 */

import assert from 'node:assert';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DescribeStackResourceCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DescribeUserPoolCommand } from '@aws-sdk/client-cognito-identity-provider';
import { type LiveUserPool, parseSnapshot } from './cdk/immutability.js';
import { createGuardHandler, GUARD_PHYSICAL_ID, type GuardEvent } from './cdk/immutability-guard-lambda.js';
import type { CfnResourceJson, CfnTemplateJson } from './test-support/cdk-synth.js';
import { defaultBaselineFile, freshAppDir, type GuardSynthResult, synthGuarded } from './test-support/guard-synth.js';

const STACK_ID = 'arn:aws:cloudformation:us-east-1:123456789012:stack/TestStack/00000000-0000-0000-0000-000000000000';
/** A provider secret: a real `secret: true` AppSetting (`Auth` refuses a non-secret one or a non-AppSetting). */
const SECRET = "new AppSetting(stack, 'idp-secret', { secret: true })";

/** The deployed configuration every scenario starts from. */
const BASE = "new Auth(stack, 'auth', { users: { attributes: [{ name: 'tenant' }], groups: ['admins'] } })";
/** Reach the L1 pool / client from probe JavaScript (escape hatches a customer can use). */
const L1_POOL = 'auth.userPool.node.defaultChild';
const L1_CLIENT = 'auth.userPoolClient.node.defaultChild';

const PERMITTED: Record<string, string> = {
	'password policy':
		"new Auth(stack, 'auth', { users: { attributes: [{ name: 'tenant' }], groups: ['admins'] }, emailPassword: { passwordPolicy: { minLength: 12, requireSymbols: false } } })",
	'MFA config':
		"new Auth(stack, 'auth', { users: { attributes: [{ name: 'tenant' }], groups: ['admins'] }, mfa: { mode: 'optional', types: ['TOTP'] } })",
	'token validities (client)': `const auth = ${BASE}; ${L1_CLIENT}.addPropertyOverride('AccessTokenValidity', 30); ${L1_CLIENT}.addPropertyOverride('IdTokenValidity', 30); ${L1_CLIENT}.addPropertyOverride('RefreshTokenValidity', 7); ${L1_CLIENT}.addPropertyOverride('TokenValidityUnits', { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'days' });`,
	'callback URLs (client)': `const auth = ${BASE}; ${L1_CLIENT}.addPropertyOverride('CallbackURLs', ['https://app.example.com/aws-blocks/auth/callback']); ${L1_CLIENT}.addPropertyOverride('LogoutURLs', ['https://app.example.com/']);`,
	'SupportedIdentityProviders (client)': `const auth = ${BASE}; ${L1_CLIENT}.addPropertyOverride('SupportedIdentityProviders', ['COGNITO', 'Google']);`,
	'adding a social provider': `new Auth(stack, 'auth', { users: { attributes: [{ name: 'tenant' }], groups: ['admins'] }, socialProviders: { google: { clientId: 'g-client', clientSecret: ${SECRET} } } })`,
	'adding a custom attribute':
		"new Auth(stack, 'auth', { users: { attributes: [{ name: 'tenant' }, { name: 'plan', type: 'Number' }], groups: ['admins'] } })",
	'adding a group':
		"new Auth(stack, 'auth', { users: { attributes: [{ name: 'tenant' }], groups: ['admins', 'editors'] } })",
	'removal policy + deletion protection':
		"new Auth(stack, 'auth', { users: { attributes: [{ name: 'tenant' }], groups: ['admins'] }, removalPolicy: 'retain', deletionProtection: true })",
	// BASE resolves to ACTIVE (the harness default is production); `false` now drops the property (L20).
	'turning deletion protection off (DeletionProtection ACTIVE → omitted)':
		"new Auth(stack, 'auth', { users: { attributes: [{ name: 'tenant' }], groups: ['admins'] }, deletionProtection: false })",
	'stating the default CaseSensitive: true': `const auth = ${BASE}; ${L1_POOL}.usernameConfiguration = { caseSensitive: true };`,
	// Q10: `validateUser` adds the PreSignUp trigger (`LambdaConfig`), an in-place pool update.
	'adding validateUser (PreSignUp trigger, LambdaConfig)':
		"new Auth(stack, 'auth', { users: { attributes: [{ name: 'tenant' }], groups: ['admins'] }, validateUser: async () => {} })",
};

const GUARDED: Record<string, { build: string; property: string; message: RegExp }> = {
	'sign-in attributes (signInWith)': {
		build: "new Auth(stack, 'auth', { users: { signInWith: ['email'], attributes: [{ name: 'tenant' }], groups: ['admins'] } })",
		property: 'signInAttributes',
		message: /users\.signInWith`\): UsernameAttributes \[\] → \[email\]; AliasAttributes \[email\] → \[\]/,
	},
	'UsernameConfiguration.CaseSensitive': {
		build: `const auth = ${BASE}; ${L1_POOL}.usernameConfiguration = { caseSensitive: false };`,
		property: 'caseSensitive',
		message: /CaseSensitive: true → false/,
	},
	'required attributes': {
		build: `const auth = ${BASE}; ${L1_POOL}.schema = [...${L1_POOL}.schema, { name: 'email', attributeDataType: 'String', mutable: true, required: true }];`,
		property: 'requiredAttributes',
		message: /required attributes: \[\] → \[email\]/,
	},
	'changing a custom attribute': {
		build: "new Auth(stack, 'auth', { users: { attributes: [{ name: 'tenant', mutable: false }], groups: ['admins'] } })",
		property: 'customAttribute',
		message: /custom:tenant' changed: String, mutable → String, immutable/,
	},
	'removing a custom attribute': {
		build: "new Auth(stack, 'auth', { users: { groups: ['admins'] } })",
		property: 'customAttribute',
		message: /custom:tenant' removed/,
	},
};

const POOL_REMOVED: Record<string, string> = {
	'last pool-backed method removed (direct OIDC only)':
		"new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { okta: { issuer: 'https://dev-1.okta.com', clientId: '0oa1' } } })",
	'owned pool swapped for a wrapped one (userPool)':
		"new Auth(stack, 'auth', { userPool: Auth.fromExisting('us-east-1_existing') })",
};

// ── Harness ───────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
after(() => {
	for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
function appDir(): string {
	const dir = freshAppDir();
	tempDirs.push(dir);
	return dir;
}

let baseCache: { dir: string; result: GuardSynthResult } | undefined;
/** BASE synthesized once, into an app dir that now holds its baseline. */
function baseSynth(): { dir: string; result: GuardSynthResult } {
	if (!baseCache) {
		const dir = appDir();
		const result = synthGuarded({ build: BASE, appDir: dir });
		assert.ok(result.ok, result.stderr);
		baseCache = { dir, result };
	}
	return baseCache;
}

/** A fresh app dir holding BASE's committed baseline — the state after BASE was deployed. */
function deployedAppDir(): string {
	const dir = appDir();
	mkdirSync(join(dir, 'aws-blocks'), { recursive: true });
	cpSync(join(baseSynth().dir, 'aws-blocks', 'baselines'), join(dir, 'aws-blocks', 'baselines'), { recursive: true });
	return dir;
}

function asBuild(code: string): string {
	return code.startsWith('const ') ? code : `const auth = ${code};`;
}

function guardResource(template: CfnTemplateJson | undefined): CfnResourceJson | undefined {
	return Object.values(template?.Resources ?? {}).find((r) => r.Type === 'Custom::BlocksAuthPoolGuard');
}

function guardProps(template: CfnTemplateJson | undefined): Record<string, unknown> {
	const props = guardResource(template)?.Properties;
	assert.ok(props, 'the template has the guard custom resource');
	return props;
}

/** A Cognito `DescribeUserPool` answer for BASE as deployed — every standard attribute, Cognito's defaults filled in. */
function liveBasePool(): LiveUserPool {
	const standard = [
		'address',
		'birthdate',
		'email',
		'family_name',
		'gender',
		'given_name',
		'locale',
		'middle_name',
		'name',
		'nickname',
		'phone_number',
		'picture',
		'preferred_username',
		'profile',
		'updated_at',
		'website',
		'zoneinfo',
		'email_verified',
		'phone_number_verified',
		'identities',
	];
	return {
		AliasAttributes: ['email'],
		UsernameConfiguration: { CaseSensitive: true },
		SchemaAttributes: [
			{
				Name: 'sub',
				AttributeDataType: 'String',
				DeveloperOnlyAttribute: false,
				Mutable: false,
				Required: true,
				StringAttributeConstraints: { MinLength: '1', MaxLength: '2048' },
			},
			...standard.map((Name) => ({
				Name,
				AttributeDataType: 'String',
				DeveloperOnlyAttribute: false,
				Mutable: true,
				Required: false,
				StringAttributeConstraints: { MinLength: '0', MaxLength: '2048' },
			})),
			{
				Name: 'custom:tenant',
				AttributeDataType: 'String',
				DeveloperOnlyAttribute: false,
				Mutable: true,
				Required: false,
				StringAttributeConstraints: {},
			},
		],
	};
}

interface Calls {
	names: string[];
}

/** Stub SDK clients: the stack is mid-update; the pool exists (or not) with `live`. */
function stubs(options: { live?: LiveUserPool; stackStatus?: string; poolInStack?: boolean } = {}) {
	const calls: Calls = { names: [] };
	const cloudformation = {
		async send(command: object): Promise<unknown> {
			calls.names.push(command.constructor.name);
			if (command instanceof DescribeStacksCommand) {
				return { Stacks: [{ StackStatus: options.stackStatus ?? 'UPDATE_IN_PROGRESS' }] };
			}
			if (command instanceof DescribeStackResourceCommand) {
				if (options.poolInStack === false) {
					throw Object.assign(new Error('Resource authpool does not exist for stack TestStack'), {
						name: 'ValidationError',
					});
				}
				return {
					StackResourceDetail: {
						PhysicalResourceId: 'us-east-1_LivePool',
						ResourceStatus: 'UPDATE_COMPLETE',
					},
				};
			}
			throw new Error(`unexpected CloudFormation call ${command.constructor.name}`);
		},
	};
	const cognito = {
		async send(command: object): Promise<unknown> {
			calls.names.push(command.constructor.name);
			if (command instanceof DescribeUserPoolCommand) return { UserPool: options.live ?? liveBasePool() };
			throw new Error(`unexpected Cognito call ${command.constructor.name}`);
		},
	};
	const logs: string[] = [];
	return { calls, logs, handler: createGuardHandler({ cloudformation, cognito, log: (m) => logs.push(m) }) };
}

function updateEvent(oldProps: Record<string, unknown>, newProps: Record<string, unknown>): GuardEvent {
	return {
		RequestType: 'Update',
		StackId: STACK_ID,
		PhysicalResourceId: GUARD_PHYSICAL_ID,
		ResourceProperties: newProps,
		OldResourceProperties: oldProps,
	};
}

function createEvent(props: Record<string, unknown>): GuardEvent {
	return { RequestType: 'Create', StackId: STACK_ID, ResourceProperties: props };
}

// ── Paired negative tests: permitted changes pass BOTH layers ──────────────

describe('permitted changes pass both layers', () => {
	for (const [name, build] of Object.entries(PERMITTED)) {
		describe(name, () => {
			let variant: GuardSynthResult | undefined;
			const synthVariant = (): GuardSynthResult => {
				variant ??= synthGuarded({ build: asBuild(build), appDir: deployedAppDir() });
				return variant;
			};

			test('layer 1: synth against the committed baseline passes', () => {
				const result = synthVariant();
				assert.ok(result.ok, `a permitted change failed synth:\n${result.stderr}`);
			});

			test('layer 2 (Update): the guard passes BASE → variant', async () => {
				const { handler, calls } = stubs();
				const out = await handler(
					updateEvent(guardProps(baseSynth().result.template), guardProps(synthVariant().template)),
				);
				assert.strictEqual(out.PhysicalResourceId, GUARD_PHYSICAL_ID);
				// The Update path compares against the previous snapshot; it reads nothing live.
				assert.deepStrictEqual(calls.names, ['DescribeStacksCommand']);
			});

			test('layer 2 (Create, guard new beside the live BASE pool): passes', async () => {
				const { handler } = stubs();
				await handler(createEvent(guardProps(synthVariant().template)));
			});
		});
	}

	test('the deletion-protection case really drops the property: BASE has ACTIVE, the variant omits it', () => {
		const poolProps = (template: CfnTemplateJson | undefined) =>
			Object.values(template?.Resources ?? {}).find((r) => r.Type === 'AWS::Cognito::UserPool')?.Properties;
		assert.strictEqual(poolProps(baseSynth().result.template)?.DeletionProtection, 'ACTIVE');
		const variant = synthGuarded({
			build: asBuild(PERMITTED['turning deletion protection off (DeletionProtection ACTIVE → omitted)']),
			appDir: deployedAppDir(),
		});
		assert.ok(variant.ok, variant.stderr);
		assert.ok(!('DeletionProtection' in (poolProps(variant.template) ?? {})));
	});

	test('the validateUser case really adds the trigger: BASE has no LambdaConfig, the variant has PreSignUp', () => {
		const poolProps = (template: CfnTemplateJson | undefined) =>
			Object.values(template?.Resources ?? {}).find((r) => r.Type === 'AWS::Cognito::UserPool')?.Properties;
		assert.strictEqual(poolProps(baseSynth().result.template)?.LambdaConfig, undefined);
		const variant = synthGuarded({
			build: asBuild(PERMITTED['adding validateUser (PreSignUp trigger, LambdaConfig)']),
			appDir: deployedAppDir(),
		});
		assert.ok(variant.ok, variant.stderr);
		const lambdaConfig = poolProps(variant.template)?.LambdaConfig as Record<string, unknown> | undefined;
		assert.deepStrictEqual(Object.keys(lambdaConfig ?? {}), ['PreSignUp']);
	});

	test('adding a pool to a pool-less config is permitted (and the guard then sees no pool yet)', async () => {
		const dir = appDir();
		const poolless = synthGuarded({
			build: `const auth = ${POOL_REMOVED['last pool-backed method removed (direct OIDC only)']};`,
			appDir: dir,
		});
		assert.ok(poolless.ok, poolless.stderr);
		assert.strictEqual(guardResource(poolless.template), undefined, 'no pool → no guard (Q6)');
		const withPool = synthGuarded({ build: asBuild(BASE), appDir: dir });
		assert.ok(withPool.ok, withPool.stderr);
		assert.ok(withPool.infos.some((m) => m.includes('updated the user-pool baseline')));
		const { handler, calls } = stubs({ poolInStack: false });
		await handler(createEvent(guardProps(withPool.template)));
		assert.deepStrictEqual(calls.names, ['DescribeStacksCommand', 'DescribeStackResourceCommand']);
	});
});

// ── Guarded changes fail BOTH layers ───────────────────────────────────────

describe('each service-immutable property is refused by both layers', () => {
	for (const [name, scenario] of Object.entries(GUARDED)) {
		describe(name, () => {
			let failed: GuardSynthResult | undefined;
			let rebaselined: { result: GuardSynthResult; dir: string } | undefined;
			const synthFailing = () => {
				failed ??= synthGuarded({ build: asBuild(scenario.build), appDir: deployedAppDir() });
				return failed;
			};
			/** The same change with the escape hatch — gives layer 2 the variant template. */
			const synthRebaselined = () => {
				if (!rebaselined) {
					const dir = deployedAppDir();
					rebaselined = {
						dir,
						result: synthGuarded({
							build: asBuild(scenario.build),
							appDir: dir,
							env: { BLOCKS_AUTH_REBASELINE: 'TestStack-auth' },
						}),
					};
				}
				return rebaselined;
			};

			test('layer 1: synth fails, naming the property, old → new, why, and the remedy', () => {
				const result = synthFailing();
				assert.strictEqual(result.ok, false, 'synth must fail');
				assert.match(
					result.stderr,
					/Auth 'TestStack-auth': this change cannot be deployed to the existing user pool/,
				);
				assert.match(result.stderr, scenario.message);
				assert.match(result.stderr, /Remedy: Revert the change\. .*new user pool and a user migration/);
				assert.match(result.stderr, /Changing an immutable pool property/);
				assert.match(result.stderr, /BLOCKS_AUTH_REBASELINE=TestStack-auth/);
			});

			test('layer 1: the baseline is left untouched by the failed synth', () => {
				synthFailing();
				const dir = deployedAppDir();
				const pristine = readFileSync(defaultBaselineFile(dir), 'utf8');
				synthGuarded({ build: asBuild(scenario.build), appDir: dir });
				assert.strictEqual(readFileSync(defaultBaselineFile(dir), 'utf8'), pristine);
			});

			test('escape hatch: BLOCKS_AUTH_REBASELINE=<fullId> passes and rewrites the baseline', () => {
				const { result, dir } = synthRebaselined();
				assert.ok(result.ok, result.stderr);
				assert.ok(result.infos.some((m) => m.includes('BLOCKS_AUTH_REBASELINE accepted')));
				// The next plain synth of the same config passes against the new baseline.
				const again = synthGuarded({ build: asBuild(scenario.build), appDir: dir });
				assert.ok(again.ok, again.stderr);
			});

			test('layer 2 (Update): the guard refuses BASE → variant before the pool update', async () => {
				const { handler } = stubs();
				const event = updateEvent(
					guardProps(baseSynth().result.template),
					guardProps(synthRebaselined().result.template),
				);
				await assert.rejects(handler(event), (e: Error) => {
					assert.match(
						e.message,
						/Auth 'TestStack-auth': refused before the user-pool update ran \(the pool was not modified\)/,
					);
					assert.match(e.message, scenario.message);
					assert.match(e.message, /Remedy: Revert the change/);
					return true;
				});
			});

			test('layer 2 (Create, guard new beside the live BASE pool): refuses', async () => {
				const { handler } = stubs();
				await assert.rejects(
					handler(createEvent(guardProps(synthRebaselined().result.template))),
					scenario.message,
				);
			});

			test('layer 2: never blocks the rollback that follows (previous snapshot re-sent)', async () => {
				const { handler } = stubs({ stackStatus: 'UPDATE_ROLLBACK_IN_PROGRESS' });
				const event = updateEvent(
					guardProps(synthRebaselined().result.template),
					guardProps(baseSynth().result.template),
				);
				await handler(event);
			});
		});
	}

	test('another block named in BLOCKS_AUTH_REBASELINE does not unlock this one', () => {
		const result = synthGuarded({
			build: asBuild(GUARDED['sign-in attributes (signInWith)'].build),
			appDir: deployedAppDir(),
			env: { BLOCKS_AUTH_REBASELINE: 'OtherStack-auth' },
		});
		assert.strictEqual(result.ok, false);
	});
});

describe('pool removal is refused at synth (layer 1)', () => {
	for (const [name, build] of Object.entries(POOL_REMOVED)) {
		test(name, () => {
			const result = synthGuarded({ build: asBuild(build), appDir: deployedAppDir() });
			assert.strictEqual(result.ok, false, 'synth must fail');
			assert.match(result.stderr, /the user pool would be removed from the stack/);
			assert.match(result.stderr, /deletes the pool and every user in it/);
			assert.match(
				result.stderr,
				/If removing the pool is deliberate, re-baseline: BLOCKS_AUTH_REBASELINE=TestStack-auth/,
			);
		});
	}

	test('…and deliberately allowed with the escape hatch', () => {
		const result = synthGuarded({
			build: asBuild(POOL_REMOVED['last pool-backed method removed (direct OIDC only)']),
			appDir: deployedAppDir(),
			env: { BLOCKS_AUTH_REBASELINE: 'TestStack-auth' },
		});
		assert.ok(result.ok, result.stderr);
		assert.strictEqual(guardResource(result.template), undefined, 'no pool → no guard resources (Q6)');
	});
});

// ── The baseline file ──────────────────────────────────────────────────────

describe('the baseline file', () => {
	test('first synth writes it next to the backend handler, says to commit it, and passes', () => {
		const { dir, result } = baseSynth();
		const file = defaultBaselineFile(dir);
		assert.ok(existsSync(file), `expected ${file}`);
		assert.ok(result.infos.some((m) => m.includes('wrote the user-pool baseline') && m.includes('Commit it')));
		const baseline = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
		assert.strictEqual(baseline.stack, 'TestStack');
		assert.strictEqual(baseline.fullId, 'TestStack-auth');
		assert.strictEqual(baseline.ownsPool, true);
		assert.deepStrictEqual(parseSnapshot(baseline.pool)?.aliasAttributes, ['email']);
	});

	test('its location does not depend on the directory synth runs from', () => {
		const dir = appDir();
		const elsewhere = join(tmpdir());
		const result = synthGuarded({ build: asBuild(BASE), appDir: dir, cwd: elsewhere });
		assert.ok(result.ok, result.stderr);
		assert.ok(existsSync(defaultBaselineFile(dir)));
	});

	test('an unchanged synth reports nothing and leaves the file byte-identical', () => {
		const dir = deployedAppDir();
		const before = readFileSync(defaultBaselineFile(dir), 'utf8');
		const result = synthGuarded({ build: asBuild(BASE), appDir: dir });
		assert.ok(result.ok, result.stderr);
		assert.deepStrictEqual(
			result.infos.filter((m) => m.includes('baseline')),
			[],
		);
		assert.strictEqual(readFileSync(defaultBaselineFile(dir), 'utf8'), before);
	});

	// A4: an `AuthCognito` app has no baseline, so the first `Auth` synth cannot
	// refuse a config that drops the pool — it can only warn, loudly.
	const POOL_DELETE_WARNING =
		/If this stack previously had a user pool for this block \(e\.g\. from `AuthCognito`\), this deploy will delete it/;
	const poolWarnings = (r: GuardSynthResult) => r.warnings.filter((m) => POOL_DELETE_WARNING.test(m));

	for (const [name, build] of Object.entries(POOL_REMOVED)) {
		test(`a first-ever baseline with no owned pool warns that a previous pool would be deleted: ${name}`, () => {
			const dir = appDir();
			const first = synthGuarded({ build: asBuild(build), appDir: dir });
			assert.ok(first.ok, first.stderr);
			const [warning, ...rest] = poolWarnings(first);
			assert.ok(warning, `expected the pool-deletion warning, got ${JSON.stringify(first.warnings)}`);
			assert.deepStrictEqual(rest, [], 'one warning per block');
			assert.match(warning, /^Auth 'TestStack-auth': this is the block's first baseline/);
			assert.match(warning, /see MIGRATION\.md in @aws-blocks\/bb-auth/);
			assert.match(warning, /Deploy the migrated code unchanged first, commit its baseline/);
			const baseline = JSON.parse(readFileSync(defaultBaselineFile(dir), 'utf8')) as Record<string, unknown>;
			assert.strictEqual(baseline.ownsPool, false);

			// Once the baseline exists, the same config is no longer a first synth: no warning.
			const again = synthGuarded({ build: asBuild(build), appDir: dir });
			assert.ok(again.ok, again.stderr);
			assert.deepStrictEqual(poolWarnings(again), []);
		});
	}

	test('a first-ever baseline that records an owned pool does not warn', () => {
		const { result } = baseSynth();
		assert.ok(
			result.infos.some((m) => m.includes('wrote the user-pool baseline')),
			'this was a first synth',
		);
		assert.deepStrictEqual(poolWarnings(result), []);
	});

	test('a deliberate re-baseline to a pool-less config does not repeat the first-synth warning', () => {
		const result = synthGuarded({
			build: asBuild(POOL_REMOVED['last pool-backed method removed (direct OIDC only)']),
			appDir: deployedAppDir(),
			env: { BLOCKS_AUTH_REBASELINE: 'TestStack-auth' },
		});
		assert.ok(result.ok, result.stderr);
		assert.deepStrictEqual(poolWarnings(result), []);
	});

	test('outside a Blocks stack (no backendHandlerPath) no file is written and synth passes', () => {
		const result = synthGuarded({ build: asBuild(GUARDED['sign-in attributes (signInWith)'].build) });
		assert.ok(result.ok, result.stderr);
	});
});

// ── Layer 2 wiring and handler semantics ───────────────────────────────────

describe('the deploy-time guard: wiring', () => {
	const template = () => baseSynth().result.template as CfnTemplateJson;
	const poolEntry = () => Object.entries(template().Resources).find(([, r]) => r.Type === 'AWS::Cognito::UserPool');

	test('the pool DependsOn the guard, and nothing in the guard references the pool (the guard runs first)', () => {
		const [poolId, pool] = poolEntry() ?? [];
		assert.ok(poolId && pool);
		assert.deepStrictEqual(pool.DependsOn, ['BlocksAuthPoolGuard']);
		for (const [id, r] of Object.entries(template().Resources)) {
			if (!String(r.Metadata?.['aws:cdk:path']).startsWith('TestStack/BlocksAuthPoolGuard')) continue;
			const json = JSON.stringify({ ...r, Properties: { ...r.Properties, Pools: undefined } });
			assert.ok(!json.includes(poolId), `${id} must not reference the pool (that would order it after the pool)`);
		}
		const pools = guardProps(template()).Pools as { FullId: string; PoolLogicalId: string; Snapshot: string }[];
		assert.deepStrictEqual(
			pools.map((p) => [p.FullId, p.PoolLogicalId]),
			[['TestStack-auth', poolId]],
		);
		assert.strictEqual(
			typeof pools[0].Snapshot,
			'string',
			'snapshot is JSON-encoded (CloudFormation stringifies values)',
		);
	});

	test('least-privilege, read-only IAM; the Lambda is not placed in a VPC', () => {
		const resources = Object.values(template().Resources);
		const fn = resources.find(
			(r) =>
				r.Type === 'AWS::Lambda::Function' &&
				r.Metadata?.['aws:cdk:path'] === 'TestStack/BlocksAuthPoolGuardFn/Resource',
		);
		assert.ok(fn, 'guard Lambda');
		assert.strictEqual(fn.Properties?.VpcConfig, undefined);
		const policy = resources.find(
			(r) =>
				r.Metadata?.['aws:cdk:path'] === 'TestStack/BlocksAuthPoolGuardFn/ServiceRole/DefaultPolicy/Resource',
		);
		const statements = (
			policy?.Properties?.PolicyDocument as { Statement: { Action: unknown; Resource: unknown }[] }
		).Statement;
		assert.deepStrictEqual(statements, [
			{
				Action: ['cloudformation:DescribeStacks', 'cloudformation:DescribeStackResource'],
				Effect: 'Allow',
				Resource: { Ref: 'AWS::StackId' },
			},
			{
				Action: 'cognito-idp:DescribeUserPool',
				Effect: 'Allow',
				Resource: {
					'Fn::Join': [
						'',
						[
							'arn:',
							{ Ref: 'AWS::Partition' },
							':cognito-idp:',
							{ Ref: 'AWS::Region' },
							':',
							{ Ref: 'AWS::AccountId' },
							':userpool/*',
						],
					],
				},
			},
		]);
	});

	test('the Lambda asset is built (dist/immutability-guard-lambda/index.js)', () => {
		const dist = dirname(fileURLToPath(import.meta.url));
		assert.ok(existsSync(join(dist, 'immutability-guard-lambda', 'index.js')), 'run `npm run build:lambda`');
	});

	test('two Auth blocks share one guard; both pools depend on it', () => {
		const result = synthGuarded({
			build: "new Auth(stack, 'auth'); new Auth(stack, 'staff', { users: { signInWith: ['email'] } });",
			appDir: appDir(),
		});
		assert.ok(result.ok, result.stderr);
		const resources = Object.values(result.template?.Resources ?? {});
		assert.strictEqual(resources.filter((r) => r.Type === 'Custom::BlocksAuthPoolGuard').length, 1);
		const pools = resources.filter((r) => r.Type === 'AWS::Cognito::UserPool');
		assert.strictEqual(pools.length, 2);
		for (const p of pools) assert.deepStrictEqual(p.DependsOn, ['BlocksAuthPoolGuard']);
		const entries = guardProps(result.template).Pools as { FullId: string }[];
		assert.deepStrictEqual(entries.map((e) => e.FullId).sort(), ['TestStack-auth', 'TestStack-staff']);
	});

	test('no guard without an owned pool (Q6): pool-less and wrapped-pool configs', () => {
		for (const build of Object.values(POOL_REMOVED)) {
			const result = synthGuarded({ build: asBuild(build), appDir: appDir() });
			assert.ok(result.ok, result.stderr);
			const paths = Object.values(result.template?.Resources ?? {}).map((r) =>
				String(r.Metadata?.['aws:cdk:path']),
			);
			assert.deepStrictEqual(
				paths.filter((p) => p.includes('BlocksAuthPoolGuard')),
				[],
			);
		}
	});
});

describe('the deploy-time guard: handler semantics', () => {
	const props = () => guardProps(baseSynth().result.template);

	test('Delete is a no-op that makes no AWS call (never blocks stack deletion)', async () => {
		const { handler, calls } = stubs();
		const out = await handler({
			RequestType: 'Delete',
			StackId: STACK_ID,
			PhysicalResourceId: GUARD_PHYSICAL_ID,
			ResourceProperties: props(),
		});
		assert.strictEqual(out.PhysicalResourceId, GUARD_PHYSICAL_ID);
		assert.deepStrictEqual(calls.names, []);
	});

	test('Create on a new stack: the pool is not in the stack yet → passes', async () => {
		const { handler, calls } = stubs({ poolInStack: false });
		const out = await handler(createEvent(props()));
		assert.strictEqual(out.PhysicalResourceId, GUARD_PHYSICAL_ID);
		assert.deepStrictEqual(calls.names, ['DescribeStacksCommand', 'DescribeStackResourceCommand']);
	});

	test('Create beside an existing pool reads it by logical id, then DescribeUserPool', async () => {
		const { handler, calls } = stubs();
		await handler(createEvent(props()));
		assert.deepStrictEqual(calls.names, [
			'DescribeStacksCommand',
			'DescribeStackResourceCommand',
			'DescribeUserPoolCommand',
		]);
	});

	test('any rollback status passes without comparing', async () => {
		for (const status of ['UPDATE_ROLLBACK_IN_PROGRESS', 'ROLLBACK_IN_PROGRESS', 'IMPORT_ROLLBACK_IN_PROGRESS']) {
			const { handler, calls } = stubs({ stackStatus: status, live: { UsernameAttributes: ['phone_number'] } });
			await handler(createEvent(props()));
			assert.deepStrictEqual(calls.names, ['DescribeStacksCommand']);
		}
	});

	test('lookup failures pass with a log line (the guard never adds a new way to fail)', async () => {
		const cloudformation = {
			async send(command: object): Promise<unknown> {
				if (command instanceof DescribeStacksCommand)
					return { Stacks: [{ StackStatus: 'UPDATE_IN_PROGRESS' }] };
				throw Object.assign(new Error('User is not authorized'), { name: 'AccessDenied' });
			},
		};
		const logs: string[] = [];
		const handler = createGuardHandler({
			cloudformation,
			cognito: { send: async () => ({}) },
			log: (m) => logs.push(m),
		});
		await handler(createEvent(props()));
		assert.ok(logs.some((m) => m.includes('DescribeStackResource') && m.includes('passing')));
	});

	test('a pool that leaves `Pools` (removed from the stack) is not this layer’s call', async () => {
		const { handler } = stubs();
		await handler(updateEvent(props(), { ...props(), Pools: [] }));
	});

	test('an unreadable previous snapshot falls back to the live pool', async () => {
		const pools = props().Pools as Record<string, unknown>[];
		const old = { ...props(), Pools: pools.map((p) => ({ ...p, Snapshot: '{"version":0}' })) };
		const { handler, calls } = stubs({
			live: { ...liveBasePool(), AliasAttributes: [], UsernameAttributes: ['email'] },
		});
		await assert.rejects(handler(updateEvent(old, props())), /sign-in attributes/);
		assert.ok(calls.names.includes('DescribeUserPoolCommand'));
	});
});
