// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * RESOURCE-IDENTITY GATE for `Auth` against `AuthCognito`. If this test fails, STOP.
 *
 * An app that switches from `AuthCognito` to `Auth` (same block id) must keep
 * its user pool, its app client, its groups and its session secret:
 * CloudFormation identifies a resource by its logical ID, which CDK derives
 * from the construct path. A renamed child construct, a changed
 * `userPoolName`, or a `client` that generates a secret makes CloudFormation
 * create a NEW user pool / client and DELETE the old one — every user in that
 * app is gone.
 *
 * One resource is deliberately not kept: the sessions table. `Auth` builds its
 * session store under the child id `session-store`, so the upgrade creates a
 * new table (`<fullId>-session-store`) and removes the `sessions` table from
 * the stack. The gate pins that too: no resource under the old logical id, and
 * exactly one session store table with that path and name
 * (`expectedAuthIdentity` in `test-support/identity.ts`). Signed-in sessions end
 * at the upgrade; users sign in once more (MIGRATION.md).
 *
 * This test runs `AuthCognito`'s golden fixture — `bb-auth-cognito`'s
 * `__fixtures__/resource-identity.json`, vendored **unchanged** as
 * `__fixtures__/authcognito-resource-identity.json` (`bb-auth-cognito` itself
 * was deleted at the cutover; its hash pins the copy) — against `Auth`. For each
 * pinned `AuthCognito` variant it synthesizes the equivalent `Auth`
 * configuration under `--conditions=cdk` and requires the identical logical
 * IDs, Types, construct paths and physical names (the session store excepted,
 * as above), the identical
 * `BLOCKS_AUTH_COGNITO_*` config keys and values, the `auth_<fullId>` cookie
 * name, and no `GenerateSecret`. The only field not compared is the fixture's
 * `construct` label (the customer code differs: `AuthOptions` is a new shape).
 *
 * The fixture must never be edited here. If `Auth` cannot match it, that is a
 * blocking incompatibility — report it; do not regenerate.
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
	expectedAuthIdentity,
	expectedConfigKeys,
	LEGACY_SESSIONS_LOGICAL_ID,
	SESSION_STORE_TABLE_PATH,
	type SynthesizedAuth,
	sessionStoreIdOf,
	synthIdentity,
	type VariantIdentity,
} from './test-support/identity.js';

// Tests run from `dist/`; the fixtures are source files (tsc does not copy JSON).
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const FIXTURE_PATH = join(SRC_DIR, '__fixtures__', 'authcognito-resource-identity.json');
/**
 * SHA-256 of the original, `bb-auth-cognito/src/__fixtures__/resource-identity.json`,
 * as it was when the package was deleted at the cutover. Until then this
 * test compared the two files byte for byte; the hash keeps that check.
 */
const B1_FIXTURE_SHA256 = '2ddc53c9a77eaf1ca674aac86676445d9fc103f6f32a5478e0ec0f4087946b11';

interface Fixture {
	$comment: string[];
	variants: Record<string, VariantIdentity>;
}

/** Each fixture variant → the equivalent `Auth` configuration (same block id, same stack). */
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

describe('Auth — deployed resource identity equals AuthCognito (golden fixture)', () => {
	test('the vendored fixture is byte-identical to the original (never edited here)', () => {
		assert.strictEqual(createHash('sha256').update(readFileSync(FIXTURE_PATH)).digest('hex'), B1_FIXTURE_SHA256);
	});

	test('every fixture variant has an Auth equivalent', () => {
		assert.deepStrictEqual(Object.keys(fixture.variants).sort(), Object.keys(AUTH_VARIANTS).sort());
	});

	for (const name of Object.keys(AUTH_VARIANTS)) {
		describe(`variant "${name}"`, () => {
			test('resource identity matches the AuthCognito golden fixture, except the session store', () => {
				const { identity } = synthOnce(name);
				// The fixture, with the sessions table swapped for the session store.
				const expected = expectedAuthIdentity(fixture.variants[name], identity);
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
				const required = [`${BLOCK_PATH_PREFIX}client/Resource`, SESSION_STORE_TABLE_PATH];
				if (name !== 'existingPool') required.push(`${BLOCK_PATH_PREFIX}pool/Resource`);
				if (name === 'configured') {
					required.push(`${BLOCK_PATH_PREFIX}group-admins`, `${BLOCK_PATH_PREFIX}group-readers`);
				}
				for (const path of required) assert.ok(paths.includes(path), `missing frozen construct ${path}`);
			});

			test('the sessions table of AuthCognito is gone; the session store is one new table', () => {
				const { identity } = synthOnce(name);
				assert.ok(
					fixture.variants[name].resources[LEGACY_SESSIONS_LOGICAL_ID],
					'the fixture pins the old table',
				);
				assert.strictEqual(
					identity.resources[LEGACY_SESSIONS_LOGICAL_ID],
					undefined,
					'no resource under the logical id of the old sessions table',
				);
				const legacyPath = `${BLOCK_PATH_PREFIX}sessions/`;
				assert.deepStrictEqual(
					Object.values(identity.resources).filter((r) => r.path.startsWith(legacyPath)),
					[],
					'no resource under the old child id',
				);
				const tables = Object.entries(identity.resources).filter(([, r]) => r.Type === 'AWS::DynamoDB::Table');
				assert.deepStrictEqual(tables, [
					[
						sessionStoreIdOf(identity),
						{
							Type: 'AWS::DynamoDB::Table',
							path: SESSION_STORE_TABLE_PATH,
							physicalName: `${identity.fullId}-session-store`,
						},
					],
				]);
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
				// Until this test reads a cookie the runtime writes, it pins the shared
				// `sessionCookieName()` the runtime must use. Then switch to reading a real Set-Cookie back.
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
