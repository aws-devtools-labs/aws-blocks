// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * RESOURCE-IDENTITY GATE for `Auth` against `AuthCognito`. If this test fails, STOP.
 *
 * An app that switches from `AuthCognito` to `Auth` (same block id) must keep
 * every deployed resource: CloudFormation identifies a resource by its logical
 * ID, which CDK derives from the construct path. A renamed child construct, a
 * changed `userPoolName`, or a `client` that generates a secret makes
 * CloudFormation create a NEW user pool / client and DELETE the old one —
 * every user and every signed-in session in that app is gone.
 *
 * This test runs B1's golden fixture — `bb-auth-cognito`'s
 * `__fixtures__/resource-identity.json`, vendored **unchanged** as
 * `__fixtures__/authcognito-resource-identity.json` (`bb-auth-cognito` itself
 * was deleted at the cutover; its hash pins the copy) — against `Auth`. For each
 * pinned `AuthCognito` variant it synthesizes the equivalent `Auth`
 * configuration under `--conditions=cdk` and requires the identical logical
 * IDs, Types, construct paths and physical names, the identical
 * `BLOCKS_AUTH_COGNITO_*` config keys and values, the `auth_<fullId>` cookie
 * name, and no `GenerateSecret`. The only field not compared is the fixture's
 * `construct` label (the customer code differs: `AuthOptions` is a new shape).
 *
 * The fixture must never be edited here. If `Auth` cannot match it, that is the
 * plan's abort criterion for D3 — report it; do not regenerate.
 */

import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cognitoConfigKeys } from './cdk/contract.js';
import {
	BLOCK_PATH_PREFIX,
	diffIdentity,
	expectedConfigKeys,
	type SynthesizedAuth,
	synthIdentity,
	type VariantIdentity,
} from './test-support/identity.js';

// Tests run from `dist/`; the fixtures are source files (tsc does not copy JSON).
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const FIXTURE_PATH = join(SRC_DIR, '__fixtures__', 'authcognito-resource-identity.json');
/**
 * SHA-256 of B1's original, `bb-auth-cognito/src/__fixtures__/resource-identity.json`,
 * as it was when the package was deleted at the cutover (F1b). Until then this
 * test compared the two files byte for byte; the hash keeps that check.
 */
const B1_FIXTURE_SHA256 = '2ddc53c9a77eaf1ca674aac86676445d9fc103f6f32a5478e0ec0f4087946b11';

interface Fixture {
	$comment: string[];
	variants: Record<string, VariantIdentity>;
}

/** Each B1 variant → the equivalent `Auth` configuration (same block id, same stack). */
const AUTH_VARIANTS: Record<string, string> = {
	default: "new Auth(stack, 'auth')",
	configured:
		"new Auth(stack, 'auth', { users: { groups: ['admins', { name: 'readers', description: 'Read-only', precedence: 2 }], signInWith: ['email'] }, emailPassword: { selfSignUp: false }, mfa: { mode: 'optional', types: ['TOTP'] }, removalPolicy: 'retain' })",
	existingPool: "new Auth(stack, 'auth', { userPool: Auth.fromExisting('us-east-1_existing') })",
};

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;

const synthesized: Record<string, SynthesizedAuth> = {};
function synthOnce(name: string): SynthesizedAuth {
	synthesized[name] ??= synthIdentity(AUTH_VARIANTS[name]);
	return synthesized[name];
}

describe('Auth — deployed resource identity equals AuthCognito (B1 golden fixture)', () => {
	test('the vendored fixture is byte-identical to B1’s (never edited here)', () => {
		assert.strictEqual(createHash('sha256').update(readFileSync(FIXTURE_PATH)).digest('hex'), B1_FIXTURE_SHA256);
	});

	test('every B1 variant has an Auth equivalent', () => {
		assert.deepStrictEqual(Object.keys(fixture.variants).sort(), Object.keys(AUTH_VARIANTS).sort());
	});

	for (const name of Object.keys(AUTH_VARIANTS)) {
		describe(`variant "${name}"`, () => {
			test('resource identity matches the AuthCognito golden fixture', () => {
				const expected = fixture.variants[name];
				const { identity } = synthOnce(name);
				const diff = diffIdentity(expected, identity);
				assert.ok(
					diff.length === 0,
					[
						`Auth resource identity differs from AuthCognito for variant "${name}":`,
						`  AuthCognito: ${expected.construct}`,
						`  Auth:        ${AUTH_VARIANTS[name]}`,
						'',
						...diff.map((l) => `  ${l}`),
						'',
						'An AuthCognito app switching to Auth would lose or replace these resources on its next deploy.',
						'Do not edit the fixture. See the header of resource-identity.cdk.test.ts.',
					].join('\n'),
				);
				// Belt and braces: anything the per-resource diff does not model.
				const { construct: _ignored, ...actualRest } = identity;
				const { construct: _label, ...expectedRest } = expected;
				assert.deepStrictEqual(actualRest, expectedRest);
			});

			test('frozen child construct ids are present', () => {
				const paths = Object.values(synthOnce(name).identity.resources).map((r) => r.path);
				const required = [`${BLOCK_PATH_PREFIX}client/Resource`, `${BLOCK_PATH_PREFIX}sessions/table/Resource`];
				if (name !== 'existingPool') required.push(`${BLOCK_PATH_PREFIX}pool/Resource`);
				if (name === 'configured') {
					required.push(`${BLOCK_PATH_PREFIX}group-admins`, `${BLOCK_PATH_PREFIX}group-readers`);
				}
				for (const path of required) assert.ok(paths.includes(path), `missing frozen construct ${path}`);
			});

			test('userPoolName === fullId', () => {
				const { identity } = synthOnce(name);
				if (name === 'existingPool') {
					assert.strictEqual(identity.userPoolName, null, 'a bring-your-own pool must not synthesize a pool');
					return;
				}
				assert.strictEqual(identity.userPoolName, identity.fullId);
			});

			test('session-secret SSM parameter is named /<fullId>-session-secret', () => {
				const { identity } = synthOnce(name);
				const bulk = identity.resources.BlocksSecretsBulk;
				assert.ok(bulk, 'BlocksSecretsBulk (owner of the session-secret parameter) is missing');
				assert.deepStrictEqual(bulk.physicalName, [`/${identity.fullId}-session-secret`]);
			});

			test('config keys are BLOCKS_AUTH_COGNITO_<UPPER_FULLID>_{USER_POOL_ID,CLIENT_ID,REGION}', () => {
				const { identity } = synthOnce(name);
				const upper = identity.fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
				const expectedKeys = ['CLIENT_ID', 'REGION', 'USER_POOL_ID'].map(
					(s) => `BLOCKS_AUTH_COGNITO_${upper}_${s}`,
				);
				assert.deepStrictEqual(Object.keys(identity.configKeys).sort(), expectedKeys);
				// The runtime derives the same keys from `cognitoConfigKeys()`.
				assert.deepStrictEqual(expectedConfigKeys(identity.fullId), expectedKeys);
				assert.deepStrictEqual(Object.values(cognitoConfigKeys(identity.fullId)).sort(), expectedKeys);
			});

			test('session cookie is named auth_<fullId>', () => {
				// Until D5 lands a cookie writer, this pins the shared `sessionCookieName()`
				// the runtime must use. D5: switch to reading a real Set-Cookie back, as B1 does.
				const { identity } = synthOnce(name);
				assert.strictEqual(identity.sessionCookieName, `auth_${identity.fullId}`);
			});

			test('client does not set GenerateSecret: true (replace-only)', () => {
				const { template } = synthOnce(name);
				const clients = Object.entries(template.Resources).filter(
					([, r]) => r.Type === 'AWS::Cognito::UserPoolClient',
				);
				assert.strictEqual(clients.length, 1, 'expected exactly one UserPoolClient (the frozen `client`)');
				const [id, client] = clients[0];
				assert.notStrictEqual(
					client.Properties?.GenerateSecret,
					true,
					`${id}: GenerateSecret is replace-only — enabling it replaces the client and invalidates every stored refresh token. ` +
						'Hosted-UI federation must use a separate client construct.',
				);
			});
		});
	}
});
