// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * PROPERTY-LEVEL SNAPSHOT: `Auth` synthesizes the same CloudFormation as
 * `AuthCognito` for the equivalent configuration.
 *
 * The identity gate (`resource-identity.cdk.test.ts`) pins logical IDs and
 * physical names, which is what decides *replacement*. It cannot see a changed
 * property value — and several user-pool properties (sign-in/alias attributes,
 * `UsernameConfiguration`, required and existing custom attributes) are
 * immutable at the *service* level while CloudFormation reports "No
 * interruption": a changed default such as `signInWith` synths cleanly, then
 * `UpdateUserPool` rejects it and the stack rolls back. So this test compares
 * the pool and client `Properties` exactly, and then the **whole template**
 * (IAM policy, session table, secret, groups, everything), for each pair below.
 *
 * The `Auth` side is synthesized live under `--conditions=cdk` in the harness
 * stack. The `AuthCognito` side was synthesized the same way, in the same
 * harness, from the real `bb-auth-cognito` and frozen into
 * `__fixtures__/authcognito-templates.json` when the package was deleted at the
 * cutover (F1b) — proven equal to the live package in the commit that froze it
 * (see `test-support/legacy-fixtures.ts` for how to regenerate it). The
 * comparisons themselves are unchanged; only the source of the expected side
 * moved. One adjustment keeps the frozen side comparable as dependencies move
 * on: content-addressed asset hashes (aws-cdk-lib's own custom-resource
 * handlers, and the config bundle) are masked on both sides of the
 * whole-template comparison, and in exchange the full config registry — the
 * config bundle's content — is compared exactly.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';
import { PAIRS } from './test-support/authcognito-pairs.js';
import type { CfnResourceJson, CfnTemplateJson } from './test-support/cdk-synth.js';
import { type SynthesizedAuth, synthIdentity } from './test-support/identity.js';
import { frozenAuthCognitoSynths } from './test-support/legacy-fixtures.js';

/**
 * THE ALLOWLIST — the only differences `Auth` may have from `AuthCognito`, and
 * only on the `AWS::Cognito::UserPool` resource. Nothing else is tolerated —
 * apart from the deploy-time guard's new resources ({@link GUARD_ALLOWLIST}).
 *
 * Decision Q4: the pool honours the stack defaults when `removalPolicy` /
 * `deletionProtection` are unset. `AuthCognito` hard-codes `DESTROY` unless
 * `removalPolicy: 'retain'` and never sets `DeletionProtection`.
 *
 * - `DeletionPolicy` / `UpdateReplacePolicy` are template metadata: changing
 *   them updates no property of the pool.
 * - **No pool property is allowlisted under the sandbox preset** (L20, D3c).
 *   `Auth` omits `DeletionProtection` unless it resolves to `ACTIVE` (unset is
 *   already inactive), so a default `AuthCognito` → `Auth` upgrade causes no
 *   `UpdateUserPool` at all.
 * - Under the production preset (the harness default) `Auth` adds exactly
 *   `DeletionProtection: 'ACTIVE'` where `AuthCognito` has none — a real,
 *   intended in-place update. Any other value (notably `INACTIVE`) fails.
 */
const POOL_ALLOWLIST = {
	/** Resource attributes (siblings of `Properties`). Q4. */
	resourceAttributes: ['DeletionPolicy', 'UpdateReplacePolicy'],
	/** `Properties` keys `Auth` may add, per preset, with the only value each may take. */
	properties: {
		sandbox: {},
		production: { DeletionProtection: 'ACTIVE' },
	},
} as const satisfies {
	resourceAttributes: readonly string[];
	properties: Record<Preset, Readonly<Record<string, string>>>;
};

/** `production` is the harness default (no `stack.defaults` line; `BlocksStack` falls back to production). */
type Preset = 'sandbox' | 'production';
const PRESETS: readonly Preset[] = ['sandbox', 'production'];

/**
 * `Auth`'s pool `Properties` with the allowlisted additions removed — only where
 * `AuthCognito` does not set the key and `Auth` sets exactly the allowed value.
 * Anything else is left in, so the comparison fails on it.
 */
function stripAllowlistedProperties(
	preset: Preset,
	cognitoProps: Record<string, unknown> | undefined,
	authProps: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const copy = { ...authProps };
	for (const [key, allowed] of Object.entries(POOL_ALLOWLIST.properties[preset])) {
		if (cognitoProps?.[key] === undefined && copy[key] === allowed) delete copy[key];
	}
	return copy;
}

/**
 * THE GUARD ALLOWLIST (task D4, decision Q5) — the deploy-time immutability
 * guard, and nothing else. `AuthCognito` has no such guard.
 *
 * - **New resources only**, all at the stack root under `BlocksAuthPoolGuard*`
 *   (a Lambda + role + policy + log group, its `cr.Provider`, and one
 *   `Custom::BlocksAuthPoolGuard`). None is under the block's subtree, so no
 *   existing logical id — `pool`, `client`, `sessions`, `session-secret`,
 *   `group-<name>` — moves or changes; the tests below check that.
 * - **One `DependsOn` entry on the pool**: `BlocksAuthPoolGuard`. That is the
 *   ordering that makes CloudFormation run the guard *before* the pool update.
 *   `DependsOn` is template metadata: adding it updates no property of the
 *   pool, so it is not a pool update (and cannot trigger a replacement).
 */
const GUARD_ALLOWLIST = {
	/** Construct-path prefix of every resource the guard adds (stack root). */
	pathPrefix: 'TestStack/BlocksAuthPoolGuard',
	/** The guard's logical id — the only `DependsOn` entry allowed on the pool. */
	poolDependsOn: 'BlocksAuthPoolGuard',
} as const;

function isGuardResource(resource: CfnResourceJson): boolean {
	return String(resource.Metadata?.['aws:cdk:path'] ?? '').startsWith(GUARD_ALLOWLIST.pathPrefix);
}

/** `__fixtures__/authcognito-templates.json`: the `AuthCognito` side, frozen at the cutover. */
const FROZEN = frozenAuthCognitoSynths();

/** The frozen `AuthCognito` synth for pair `name` (B1's harness, same as {@link synth}). */
function authCognito(
	name: string,
	preset: Preset = 'production',
): { template: CfnTemplateJson; config: Record<string, unknown>; configKeys: Record<string, unknown> } {
	const frozen = FROZEN.presets[preset][name];
	assert.ok(frozen, `authcognito-templates.json has no ${preset} entry for pair "${name}"`);
	assert.strictEqual(
		frozen.construct,
		PAIRS[name]?.cognito,
		`the frozen "${name}" entry was captured from this pair`,
	);
	// The same extraction `synthIdentity` applies to a live synth.
	const configKeys: Record<string, unknown> = {};
	for (const key of Object.keys(frozen.config).sort()) {
		if (key.startsWith('BLOCKS_AUTH_COGNITO_')) configKeys[key] = frozen.config[key];
	}
	return { template: frozen.template, config: frozen.config, configKeys };
}

/**
 * A deep copy of `template` with content-addressed asset hashes (`<sha256>.zip`
 * object keys and bare hashes) replaced by a placeholder. Applied to both sides
 * of the whole-template comparison only: those hashes belong to aws-cdk-lib's
 * own handlers and to the config bundle, whose content is compared separately
 * (`the full config registry is identical`).
 */
function withoutAssetHashes(template: CfnTemplateJson): CfnTemplateJson {
	return JSON.parse(JSON.stringify(template).replace(/\b[0-9a-f]{64}\b/g, '<asset-hash>'));
}

const cache: Record<string, SynthesizedAuth> = {};
/** `preset: 'production'` synthesizes with the harness default (no preset line), sharing the cache with B1's identity runs. */
function synth(construct: string, preset?: Preset): SynthesizedAuth {
	const effective = preset === 'production' ? undefined : preset;
	const key = `${effective ?? ''}|${construct}`;
	cache[key] ??= synthIdentity(construct, effective);
	return cache[key];
}

function resourceOfType(template: CfnTemplateJson, type: string): [string, CfnResourceJson] | undefined {
	const found = Object.entries(template.Resources).filter(([, r]) => r.Type === type);
	assert.ok(found.length <= 1, `expected at most one ${type}, found ${found.length}`);
	return found[0];
}

/**
 * A deep copy of both templates with the allowlisted pool fields and the guard's
 * resources removed. Resource attributes and the guard's `DependsOn` go from
 * both sides; an allowlisted property only from `Auth`'s, and only when
 * {@link stripAllowlistedProperties} allows it.
 */
function withoutAllowlisted(
	preset: Preset,
	cognitoTemplate: CfnTemplateJson,
	authTemplate: CfnTemplateJson,
): [CfnTemplateJson, CfnTemplateJson] {
	const cognito = structuredClone(cognitoTemplate);
	const auth = structuredClone(authTemplate);
	const cognitoPool = resourceOfType(cognito, 'AWS::Cognito::UserPool');
	const authPool = resourceOfType(auth, 'AWS::Cognito::UserPool');
	if (authPool?.[1].Properties) {
		authPool[1].Properties = stripAllowlistedProperties(
			preset,
			cognitoPool?.[1].Properties,
			authPool[1].Properties,
		);
	}
	for (const template of [cognito, auth]) {
		const pool = resourceOfType(template, 'AWS::Cognito::UserPool');
		if (pool) {
			const [, resource] = pool;
			for (const attr of POOL_ALLOWLIST.resourceAttributes) delete resource[attr];
			if (Array.isArray(resource.DependsOn)) {
				const rest = resource.DependsOn.filter((d) => d !== GUARD_ALLOWLIST.poolDependsOn);
				if (rest.length > 0) resource.DependsOn = rest;
				else delete resource.DependsOn;
			}
		}
		for (const [id, resource] of Object.entries(template.Resources)) {
			if (isGuardResource(resource)) delete template.Resources[id];
		}
	}
	return [cognito, auth];
}

/** JSON paths at which `a` and `b` differ (for a readable failure). */
function diffPaths(a: unknown, b: unknown, path = '$'): string[] {
	if (JSON.stringify(a) === JSON.stringify(b)) return [];
	if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
		const ao = a as Record<string, unknown>;
		const bo = b as Record<string, unknown>;
		return [...new Set([...Object.keys(ao), ...Object.keys(bo)])].flatMap((k) =>
			diffPaths(ao[k], bo[k], `${path}.${k}`),
		);
	}
	return [`${path}: AuthCognito ${JSON.stringify(a)} → Auth ${JSON.stringify(b)}`];
}

function assertSame(expected: unknown, actual: unknown, what: string): void {
	const diff = diffPaths(expected, actual);
	assert.ok(diff.length === 0, [`${what} differs from AuthCognito (not on the allowlist):`, ...diff].join('\n  '));
}

describe('Auth — property-level snapshot vs AuthCognito', () => {
	test('the frozen AuthCognito side covers exactly these pairs, under both presets', (t) => {
		for (const preset of PRESETS) {
			assert.deepStrictEqual(Object.keys(FROZEN.presets[preset]).sort(), Object.keys(PAIRS).sort(), preset);
		}
		const installed = String(
			JSON.parse(readFileSync(createRequire(import.meta.url).resolve('aws-cdk-lib/package.json'), 'utf8'))
				.version,
		);
		if (installed !== FROZEN.awsCdkLib) {
			// Not a failure by itself: the pool, client and every block-owned resource still compare
			// exactly. If a shared, non-auth resource now differs below, that is the aws-cdk-lib bump.
			t.diagnostic(`AuthCognito was frozen on aws-cdk-lib ${FROZEN.awsCdkLib}; installed: ${installed}`);
		}
	});

	for (const preset of PRESETS) {
		for (const [name, pair] of Object.entries(PAIRS)) {
			describe(`${preset} preset — pair "${name}"`, () => {
				test(
					preset === 'sandbox'
						? 'pool Properties are identical (no exception)'
						: "pool Properties are identical except DeletionProtection: 'ACTIVE'",
					() => {
						const cognitoPool = resourceOfType(
							authCognito(name, preset).template,
							'AWS::Cognito::UserPool',
						);
						const authPool = resourceOfType(synth(pair.auth, preset).template, 'AWS::Cognito::UserPool');
						assert.strictEqual(authPool?.[0], cognitoPool?.[0], 'pool logical id');
						if (!cognitoPool || !authPool) return; // existing pool: nothing synthesized on either side
						assertSame(
							cognitoPool[1].Properties,
							stripAllowlistedProperties(preset, cognitoPool[1].Properties, authPool[1].Properties),
							'pool Properties',
						);
					},
				);

				test('client Properties are identical', () => {
					const cognitoClient = resourceOfType(
						authCognito(name, preset).template,
						'AWS::Cognito::UserPoolClient',
					);
					const authClient = resourceOfType(
						synth(pair.auth, preset).template,
						'AWS::Cognito::UserPoolClient',
					);
					assert.ok(cognitoClient && authClient, 'both sides synthesize the `client`');
					assert.strictEqual(authClient[0], cognitoClient[0], 'client logical id');
					assertSame(cognitoClient[1].Properties, authClient[1].Properties, 'client Properties');
				});

				test('the whole template is identical (except the allowlist)', () => {
					const [cognito, auth] = withoutAllowlisted(
						preset,
						withoutAssetHashes(authCognito(name, preset).template),
						withoutAssetHashes(synth(pair.auth, preset).template),
					);
					assertSame(cognito, auth, 'template');
				});

				test('config keys and values are identical', () => {
					assert.deepStrictEqual(
						synth(pair.auth, preset).identity.configKeys,
						authCognito(name, preset).configKeys,
					);
				});

				test('the full config registry is identical (the config bundle the asset hash stood for)', () => {
					assertSame(authCognito(name, preset).config, synth(pair.auth, preset).config, 'config registry');
				});
			});
		}
	}

	describe('the guard allowlist adds resources and changes none (D4)', () => {
		for (const [name, pair] of Object.entries(PAIRS)) {
			test(`pair "${name}": guard resources are new, at the stack root, and the pool only gains DependsOn`, () => {
				const cognito = authCognito(name).template;
				const auth = synth(pair.auth).template;
				const authPool = resourceOfType(auth, 'AWS::Cognito::UserPool');
				const guardIds = Object.entries(auth.Resources)
					.filter(([, r]) => isGuardResource(r))
					.map(([id]) => id);
				if (!authPool) {
					// A wrapped existing pool: Auth owns no pool, so there is no guard (Q6).
					assert.deepStrictEqual(guardIds, []);
					return;
				}
				assert.ok(guardIds.includes(GUARD_ALLOWLIST.poolDependsOn), 'the guard custom resource exists');
				for (const id of guardIds) {
					assert.strictEqual(cognito.Resources[id], undefined, `${id} must be a new logical id`);
					const path = String(auth.Resources[id].Metadata?.['aws:cdk:path']);
					assert.ok(!path.startsWith('TestStack/auth/'), `${id} must not sit under the block (${path})`);
				}
				assert.deepStrictEqual(authPool[1].DependsOn, [GUARD_ALLOWLIST.poolDependsOn]);
				// Every non-guard resource keeps its logical id and Type.
				for (const [id, r] of Object.entries(cognito.Resources)) {
					assert.strictEqual(auth.Resources[id]?.Type, r.Type, `${id} kept`);
				}
			});
		}
	});

	describe('users.preferredChallenge reaches the template (L22)', () => {
		const firstFactors = (construct: string): unknown => {
			const pool = resourceOfType(synth(construct).template, 'AWS::Cognito::UserPool');
			const policies = pool?.[1].Properties?.Policies as { SignInPolicy?: { AllowedFirstAuthFactors?: unknown } };
			return policies?.SignInPolicy?.AllowedFirstAuthFactors;
		};
		test("'SMS_OTP' enables that first factor, exactly as AuthCognito's option did", () => {
			assert.deepStrictEqual(firstFactors(PAIRS.preferredChallengeSmsOtp.auth), ['PASSWORD', 'SMS_OTP']);
		});
		test('unset (or PASSWORD), USER_AUTH offers only PASSWORD — the default template is unchanged', () => {
			assert.deepStrictEqual(firstFactors("new Auth(stack, 'auth', { users: { authFlow: 'USER_AUTH' } })"), [
				'PASSWORD',
			]);
			assert.deepStrictEqual(
				firstFactors(
					"new Auth(stack, 'auth', { users: { authFlow: 'USER_AUTH', preferredChallenge: 'PASSWORD' } })",
				),
				['PASSWORD'],
			);
		});
	});

	describe('the allowlisted fields differ only as Q4 says', () => {
		test('no stack defaults (the harness falls back to production): Auth retains + protects, AuthCognito destroys', () => {
			const cognitoPool = resourceOfType(authCognito('default').template, 'AWS::Cognito::UserPool');
			const authPool = resourceOfType(synth(PAIRS.default.auth).template, 'AWS::Cognito::UserPool');
			assert.ok(cognitoPool && authPool);
			assert.strictEqual(cognitoPool[1].DeletionPolicy, 'Delete');
			assert.strictEqual(cognitoPool[1].Properties?.DeletionProtection, undefined);
			assert.strictEqual(authPool[1].DeletionPolicy, 'Retain');
			assert.strictEqual(authPool[1].UpdateReplacePolicy, 'Retain');
			assert.strictEqual(authPool[1].Properties?.DeletionProtection, 'ACTIVE');
		});

		test('sandbox preset: the default pool omits DeletionProtection, exactly like AuthCognito (L20)', () => {
			const cognito = authCognito('default', 'sandbox').template;
			const auth = synth(PAIRS.default.auth, 'sandbox').template;
			const authPool = resourceOfType(auth, 'AWS::Cognito::UserPool');
			const cognitoPool = resourceOfType(cognito, 'AWS::Cognito::UserPool');
			assert.ok(authPool && cognitoPool);
			assert.strictEqual(authPool[1].DeletionPolicy, 'Delete');
			assert.strictEqual(authPool[1].UpdateReplacePolicy, 'Delete');
			// Unset is Cognito's default (inactive). Emitting INACTIVE would be a no-op UpdateUserPool.
			assert.ok(!('DeletionProtection' in (authPool[1].Properties ?? {})));
			// Under sandbox the pool differs from AuthCognito's only by the guard's DependsOn.
			const { DependsOn, ...authRest } = authPool[1];
			assert.deepStrictEqual(DependsOn, [GUARD_ALLOWLIST.poolDependsOn]);
			assertSame(cognitoPool[1], authRest, 'pool resource (sandbox preset)');
		});

		test("deletionProtection: false under the production preset omits the property (never 'INACTIVE')", () => {
			const authPool = resourceOfType(
				synth("new Auth(stack, 'auth', { deletionProtection: false })").template,
				'AWS::Cognito::UserPool',
			);
			assert.ok(authPool);
			assert.ok(!('DeletionProtection' in (authPool[1].Properties ?? {})));
		});

		test("deletionProtection: true under the sandbox preset emits 'ACTIVE' (explicit opt-in)", () => {
			const authPool = resourceOfType(
				synth("new Auth(stack, 'auth', { deletionProtection: true })", 'sandbox').template,
				'AWS::Cognito::UserPool',
			);
			assert.ok(authPool);
			assert.strictEqual(authPool[1].Properties?.DeletionProtection, 'ACTIVE');
		});

		test("explicit removalPolicy: 'retain' → both Retain; only DeletionProtection (stack default) differs", () => {
			const cognitoPool = resourceOfType(authCognito('configured').template, 'AWS::Cognito::UserPool');
			const authPool = resourceOfType(synth(PAIRS.configured.auth).template, 'AWS::Cognito::UserPool');
			assert.ok(cognitoPool && authPool);
			assert.strictEqual(authPool[1].DeletionPolicy, cognitoPool[1].DeletionPolicy);
			assert.strictEqual(authPool[1].DeletionPolicy, 'Retain');
		});
	});
});
