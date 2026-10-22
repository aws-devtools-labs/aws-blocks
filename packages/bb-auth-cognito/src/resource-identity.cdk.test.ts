// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * RESOURCE-IDENTITY GATE for `AuthCognito`. If this test fails, STOP.
 *
 * CloudFormation identifies a resource by its logical ID, which CDK derives
 * from the construct path. Every child construct id under `AuthCognito` is
 * therefore part of a deployed app's identity. Renaming `pool` → `userPool`
 * (or changing `userPoolName`, or making the `client` generate a secret)
 * makes CloudFormation create a NEW user pool and DELETE the old one — and the
 * pool's removal policy defaults to DESTROY, so every user in a production
 * pool is gone. `cdk diff` would show it; nothing else in CI did.
 *
 * This test synthesizes `AuthCognito` exactly as a customer's `cdk synth` does
 * (`--conditions=cdk`, so the nested `KVStore`/`AppSetting` emit real
 * CloudFormation) and compares, per resource, `{ logicalId, Type,
 * physicalName }` against `__fixtures__/resource-identity.json`. It also pins
 * what the runtime derives from the same `fullId` independently: the
 * `BLOCKS_AUTH_COGNITO_<FULLID>_*` config keys and the `auth_<fullId>`
 * session cookie (renaming it signs every user out).
 *
 * Frozen contract: child ids `pool`, `client`, `sessions`, `session-secret`,
 * `group-<name>`; `userPoolName: this.fullId`; `client` has no
 * `GenerateSecret: true` (replace-only — it would invalidate every stored
 * refresh token).
 *
 * Updating the fixture is a decision to destroy or replace resources in every
 * existing deployment. Do it only on purpose, with maintainer review. To
 * regenerate after an intentional change:
 *   UPDATE_RESOURCE_IDENTITY_FIXTURE=1 node --test dist/resource-identity.cdk.test.js
 * (from `packages/bb-auth-cognito`, after `npm run build`), then review the
 * JSON diff line by line.
 */

import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { BlocksContext } from '@aws-blocks/core';
import { readSessionCookie, setSessionCookie } from './cookies.js';
import { type CfnTemplateJson, synthUnderCdkConditions } from './test-support/cdk-synth.js';
import { envVarNames } from './types.js';

// Tests run from `dist/`; the fixture is a source file (tsc does not copy JSON).
const FIXTURE_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'src',
	'__fixtures__',
	'resource-identity.json',
);

/** The construct whose subtree is AuthCognito's (a `BlocksStack` id + the block id). */
const BLOCK_PATH_PREFIX = 'TestStack/auth/';

/**
 * Stack-level shared resources an AuthCognito deployment depends on. `BlocksSecretsBulk`
 * (bb-app-setting) owns the `session-secret` SSM SecureString: if its logical ID changed,
 * CloudFormation would run the old resource's Delete, which deletes every parameter it
 * manages — the session HMAC secret included, signing every user out.
 */
const SHARED_LOGICAL_IDS = ['BlocksSecretsBulk'];

interface PinnedResource {
	logicalId: string;
	Type: string;
	/** The construct path (`aws:cdk:path`) — for humans; identity is the logical ID. */
	path: string;
	/** The resource's physical name where the template sets one, else `null`. */
	physicalName: string | string[] | null;
}

interface VariantIdentity {
	/** The customer code being pinned. */
	construct: string;
	fullId: string;
	userPoolName: string | null;
	sessionCookieName: string;
	/** `BLOCKS_AUTH_COGNITO_*` config keys → resolved values (tokens show the logical ID they point at). */
	configKeys: Record<string, unknown>;
	/** Keyed by logical ID. */
	resources: Record<string, Omit<PinnedResource, 'logicalId'>>;
}

interface Fixture {
	$comment: string[];
	variants: Record<string, VariantIdentity>;
}

/** The variants pinned. Each must keep the frozen child ids regardless of options. */
const VARIANTS: Record<string, string> = {
	default: "new AuthCognito(stack, 'auth')",
	configured:
		"new AuthCognito(stack, 'auth', { groups: ['admins', { name: 'readers', description: 'Read-only', precedence: 2 }], selfSignUp: false, signInWith: 'email', mfa: 'optional', mfaTypes: ['TOTP'], removalPolicy: 'retain' })",
	existingPool: "new AuthCognito(stack, 'auth', { userPool: AuthCognito.fromExisting('us-east-1_existing') })",
};

/** Physical-name property per resource type (the property CloudFormation names the resource by). */
const PHYSICAL_NAME_PROPERTY: Record<string, string> = {
	'AWS::Cognito::UserPool': 'UserPoolName',
	'AWS::Cognito::UserPoolClient': 'ClientName',
	'AWS::Cognito::UserPoolGroup': 'GroupName',
	'AWS::Cognito::UserPoolDomain': 'Domain',
	'AWS::DynamoDB::Table': 'TableName',
	'AWS::SSM::Parameter': 'Name',
	'AWS::Lambda::Function': 'FunctionName',
	'AWS::Logs::LogGroup': 'LogGroupName',
};

function physicalNameOf(type: string, props: Record<string, unknown> | undefined): string | string[] | null {
	if (!props) return null;
	// The bulk secret initializer: its "physical names" are the SSM parameters it manages.
	if (type === 'AWS::CloudFormation::CustomResource' && Array.isArray(props.Parameters)) {
		return (props.Parameters as { name: string }[]).map((p) => p.name).sort();
	}
	const key = PHYSICAL_NAME_PROPERTY[type];
	const value = key ? props[key] : undefined;
	return typeof value === 'string' ? value : value === undefined ? null : JSON.stringify(value);
}

function pinnedResources(template: CfnTemplateJson): Record<string, Omit<PinnedResource, 'logicalId'>> {
	const out: Record<string, Omit<PinnedResource, 'logicalId'>> = {};
	for (const [logicalId, resource] of Object.entries(template.Resources).sort(([a], [b]) => a.localeCompare(b))) {
		const path = String(resource.Metadata?.['aws:cdk:path'] ?? '');
		if (!path.startsWith(BLOCK_PATH_PREFIX) && !SHARED_LOGICAL_IDS.includes(logicalId)) continue;
		out[logicalId] = {
			Type: resource.Type,
			path,
			physicalName: physicalNameOf(resource.Type, resource.Properties),
		};
	}
	return out;
}

function mockContext(): BlocksContext {
	const ctx = {
		request: { headers: new Headers(), body: null, json: async () => ({}), text: async () => '', params: {} },
		response: { headers: new Headers(), status: 200, send: () => {} },
	};
	return ctx as unknown as BlocksContext;
}

/** The cookie name the runtime actually writes for `fullId` (read back off a real Set-Cookie). */
function sessionCookieNameFor(fullId: string): string {
	const ctx = mockContext();
	setSessionCookie(ctx, fullId, 'probe-value', 60);
	const header = ctx.response.headers.get('set-cookie') ?? '';
	return header.slice(0, header.indexOf('='));
}

interface Synthesized {
	identity: VariantIdentity;
	template: CfnTemplateJson;
}

function synthVariant(construct: string): Synthesized {
	const { template, config, report } = synthUnderCdkConditions({
		imports: "import { AuthCognito } from '@aws-blocks/bb-auth-cognito';",
		build: `const auth = ${construct};\nreport.fullId = auth.fullId;`,
	});
	const fullId = String(report.fullId);
	const pools = Object.values(template.Resources).filter((r) => r.Type === 'AWS::Cognito::UserPool');
	const configKeys: Record<string, unknown> = {};
	for (const key of Object.keys(config).sort()) {
		if (key.startsWith('BLOCKS_AUTH_COGNITO_')) configKeys[key] = config[key];
	}
	return {
		template,
		identity: {
			construct,
			fullId,
			userPoolName: pools.length === 1 ? String(pools[0].Properties?.UserPoolName) : null,
			sessionCookieName: sessionCookieNameFor(fullId),
			configKeys,
			resources: pinnedResources(template),
		},
	};
}

function describeResource(logicalId: string, r: Omit<PinnedResource, 'logicalId'>): string {
	return `${logicalId}  (${r.Type}, construct path ${r.path}, physicalName ${JSON.stringify(r.physicalName)})`;
}

/** Human-readable, per-resource diff. Empty when identical. */
function diffIdentity(expected: VariantIdentity, actual: VariantIdentity): string[] {
	const lines: string[] = [];
	for (const field of ['fullId', 'userPoolName', 'sessionCookieName'] as const) {
		if (expected[field] !== actual[field]) {
			lines.push(`~ ${field}: ${JSON.stringify(expected[field])} → ${JSON.stringify(actual[field])}`);
		}
	}
	for (const key of new Set([...Object.keys(expected.configKeys), ...Object.keys(actual.configKeys)])) {
		const e = JSON.stringify(expected.configKeys[key]);
		const a = JSON.stringify(actual.configKeys[key]);
		if (!(key in actual.configKeys)) lines.push(`- config key ${key} is no longer registered (runtime reads it)`);
		else if (!(key in expected.configKeys)) lines.push(`+ new config key ${key} = ${a}`);
		else if (e !== a) lines.push(`~ config key ${key}: ${e} → ${a}`);
	}
	for (const [id, e] of Object.entries(expected.resources)) {
		const a = actual.resources[id];
		if (!a) {
			lines.push(
				`- REMOVED ${describeResource(id, e)}\n    → CloudFormation will DELETE this resource from every existing deployment.`,
			);
			continue;
		}
		for (const field of ['Type', 'physicalName', 'path'] as const) {
			if (JSON.stringify(e[field]) !== JSON.stringify(a[field])) {
				const consequence =
					field === 'path'
						? ''
						: '\n    → a Type or physical-name change makes CloudFormation REPLACE (create new, delete old) this resource.';
				lines.push(
					`~ CHANGED ${id} ${field}: ${JSON.stringify(e[field])} → ${JSON.stringify(a[field])}${consequence}`,
				);
			}
		}
	}
	for (const [id, a] of Object.entries(actual.resources)) {
		if (!expected.resources[id]) lines.push(`+ ADDED   ${describeResource(id, a)}`);
	}
	return lines;
}

function readFixture(): Fixture {
	return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
}

const synthesized: Record<string, Synthesized> = {};
function synthOnce(name: string): Synthesized {
	synthesized[name] ??= synthVariant(VARIANTS[name]);
	return synthesized[name];
}

if (process.env.UPDATE_RESOURCE_IDENTITY_FIXTURE === '1') {
	const fixture: Fixture = {
		$comment: [
			'GOLDEN resource identity of AuthCognito — enforced by src/resource-identity.cdk.test.ts.',
			'Each entry is a CloudFormation resource that exists in customer deployments. Changing a logicalId,',
			'Type or physicalName here means CloudFormation deletes or replaces that resource (user pools are',
			'DESTROY by default: every user is lost). Edit only on purpose, with maintainer review.',
		],
		variants: Object.fromEntries(Object.keys(VARIANTS).map((name) => [name, synthOnce(name).identity])),
	};
	writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, '\t')}\n`);
}

describe('AuthCognito — deployed resource identity (golden fixture)', () => {
	const fixture = readFixture();

	test('the fixture covers exactly the pinned variants', () => {
		assert.deepStrictEqual(Object.keys(fixture.variants).sort(), Object.keys(VARIANTS).sort());
	});

	for (const name of Object.keys(VARIANTS)) {
		describe(`variant "${name}"`, () => {
			test('resource identity matches the golden fixture', () => {
				const expected = fixture.variants[name];
				const { identity } = synthOnce(name);
				const diff = diffIdentity(expected, identity);
				assert.ok(
					diff.length === 0,
					[
						`AuthCognito resource identity changed for variant "${name}":`,
						`  ${VARIANTS[name]}`,
						'',
						...diff.map((l) => `  ${l}`),
						'',
						'Existing deployments would lose or replace these resources on their next deploy.',
						'If this is not deliberate, revert the change. See the header of resource-identity.cdk.test.ts.',
					].join('\n'),
				);
				// Belt and braces: anything the per-resource diff does not model.
				assert.deepStrictEqual(identity, expected);
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

			test('config keys are BLOCKS_AUTH_COGNITO_<UPPER_FULLID>_{USER_POOL_ID,CLIENT_ID,REGION} and match the runtime', () => {
				const { identity } = synthOnce(name);
				const upper = identity.fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
				const expectedKeys = ['CLIENT_ID', 'REGION', 'USER_POOL_ID'].map(
					(s) => `BLOCKS_AUTH_COGNITO_${upper}_${s}`,
				);
				assert.deepStrictEqual(Object.keys(identity.configKeys).sort(), expectedKeys);
				// The runtime (`index.aws.ts`) looks the same keys up via envVarNames().
				assert.deepStrictEqual(Object.values(envVarNames(identity.fullId)).sort(), expectedKeys);
			});

			test('session cookie is named auth_<fullId> (read back by the runtime)', () => {
				const { identity } = synthOnce(name);
				assert.strictEqual(identity.sessionCookieName, `auth_${identity.fullId}`);
				const ctx = mockContext();
				ctx.request.headers.set('cookie', `auth_${identity.fullId}=signed-value`);
				assert.strictEqual(readSessionCookie(ctx, identity.fullId), 'signed-value');
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
