// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DOCUMENTATION SNAPSHOT — NOT A DEPLOYMENT-SAFETY GATE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Records the CloudFormation identity (`{ logicalId, Type, physicalName }`) of
 * every resource `AuthOIDC` deploys, in direct mode and in `cognitoFederated()`
 * mode, in `__fixtures__/resource-identity.json`.
 *
 * Why it exists: it is the evidence behind the per-block upgrade table in the
 * auth-unification strategy doc. An app that switches from `AuthOIDC`
 * (`cognitoFederated()`) to the unified `Auth` block loses the `cognito-pool`
 * user pool (named `${fullId}-federation`, hard-coded DESTROY) because `Auth`
 * provisions its pool at child id `pool`; and the new `UserPoolDomain` reuses
 * the same globally-unique domain prefix, so the deploy fails on the collision
 * unless the prefix changes or the switch is done in two deploys. Direct mode
 * provisions no pool, so only the `sessions` table and cookie secret exist.
 *
 * Why it is NOT a CI gate: unlike `AuthCognito` (see
 * `bb-auth-cognito/src/resource-identity.cdk.test.ts`, which IS the gate),
 * there is no in-place upgrade path for `AuthOIDC` to protect — the upgrade
 * consequences are accepted and documented. It still runs (and must pass) so a
 * stale snapshot is noticed; regenerate it with
 *   UPDATE_RESOURCE_IDENTITY_FIXTURE=1 node --test dist/resource-identity.cdk.test.js
 * from `packages/bb-auth-oidc` after `npm run build`.
 *
 * It is deleted together with this package at the cutover (task F1).
 */

import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type CfnTemplateJson, synthUnderCdkConditions } from './test-support/cdk-synth.js';

// Tests run from `dist/`; the fixture is a source file (tsc does not copy JSON).
const FIXTURE_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'src',
	'__fixtures__',
	'resource-identity.json',
);

const BLOCK_PATH_PREFIX = 'TestStack/auth/';
/** bb-app-setting's stack-shared custom resource that owns the cookie-secret SecureString. */
const SHARED_LOGICAL_IDS = ['BlocksSecretsBulk'];

/** AppSetting-shaped stand-ins for the IdP credentials: the CDK layer only reads `fullId`. */
const SETTING_STUBS = `
const googleClientId = { fullId: 'TestStack-google-client-id', get: async () => '' };
const googleClientSecret = { fullId: 'TestStack-google-client-secret', get: async () => '' };
`;

const VARIANTS: Record<string, string> = {
	direct: "new AuthOIDC(stack, 'auth', { providers: [google({ clientId: async () => 'id', clientSecret: async () => 'secret' })] })",
	cognitoFederated:
		"new AuthOIDC(stack, 'auth', { providers: [cognitoFederated({ name: 'google', identityProvider: 'Google', cognitoDomain: 'myapp-abc123', region: 'us-east-1', clientId: googleClientId, clientSecret: googleClientSecret })] })",
};

const PHYSICAL_NAME_PROPERTY: Record<string, string> = {
	'AWS::Cognito::UserPool': 'UserPoolName',
	'AWS::Cognito::UserPoolClient': 'ClientName',
	'AWS::Cognito::UserPoolDomain': 'Domain',
	'AWS::DynamoDB::Table': 'TableName',
	'AWS::SSM::Parameter': 'Name',
	'AWS::Lambda::Function': 'FunctionName',
	'AWS::Logs::LogGroup': 'LogGroupName',
	'AWS::CloudFormation::CustomResource': 'ProviderName',
};

interface PinnedResource {
	Type: string;
	path: string;
	physicalName: string | string[] | null;
}

interface VariantSnapshot {
	construct: string;
	fullId: string;
	configKeys: Record<string, unknown>;
	resources: Record<string, PinnedResource>;
}

function physicalNameOf(type: string, props: Record<string, unknown> | undefined): string | string[] | null {
	if (!props) return null;
	if (type === 'AWS::CloudFormation::CustomResource' && Array.isArray(props.Parameters)) {
		return (props.Parameters as { name: string }[]).map((p) => p.name).sort();
	}
	const key = PHYSICAL_NAME_PROPERTY[type];
	const value = key ? props[key] : undefined;
	return typeof value === 'string' ? value : value === undefined ? null : JSON.stringify(value);
}

function snapshot(template: CfnTemplateJson): Record<string, PinnedResource> {
	const out: Record<string, PinnedResource> = {};
	for (const [logicalId, r] of Object.entries(template.Resources).sort(([a], [b]) => a.localeCompare(b))) {
		const path = String(r.Metadata?.['aws:cdk:path'] ?? '');
		if (!path.startsWith(BLOCK_PATH_PREFIX) && !SHARED_LOGICAL_IDS.includes(logicalId)) continue;
		out[logicalId] = { Type: r.Type, path, physicalName: physicalNameOf(r.Type, r.Properties) };
	}
	return out;
}

function synthVariant(construct: string): VariantSnapshot {
	const { template, config, report } = synthUnderCdkConditions({
		imports: "import { AuthOIDC, google, cognitoFederated } from '@aws-blocks/bb-auth-oidc';",
		build: `${SETTING_STUBS}\nconst auth = ${construct};\nreport.fullId = auth.fullId;`,
	});
	const configKeys: Record<string, unknown> = {};
	for (const key of Object.keys(config).sort()) {
		if (key.startsWith('BLOCKS_AUTH_OIDC_')) configKeys[key] = config[key];
	}
	return { construct, fullId: String(report.fullId), configKeys, resources: snapshot(template) };
}

const actual: Record<string, VariantSnapshot> = Object.fromEntries(
	Object.entries(VARIANTS).map(([name, construct]) => [name, synthVariant(construct)]),
);

if (process.env.UPDATE_RESOURCE_IDENTITY_FIXTURE === '1') {
	writeFileSync(
		FIXTURE_PATH,
		`${JSON.stringify(
			{
				$comment: [
					'DOCUMENTATION SNAPSHOT of AuthOIDC resource identity — NOT a deployment-safety gate.',
					'Evidence for the auth-unification upgrade table. See src/resource-identity.cdk.test.ts.',
					'Deleted with this package at the cutover (F1).',
				],
				variants: actual,
			},
			null,
			'\t',
		)}\n`,
	);
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { variants: Record<string, VariantSnapshot> };

for (const name of Object.keys(VARIANTS)) {
	test(`AuthOIDC resource identity snapshot (documentation, not a gate) — ${name}`, () => {
		assert.deepStrictEqual(
			actual[name],
			fixture.variants[name],
			`AuthOIDC "${name}" resources differ from the documentation snapshot. If deliberate, regenerate it ` +
				'(see the header of resource-identity.cdk.test.ts) and update the upgrade table in the strategy doc.',
		);
	});
}

test('cognitoFederated mode: the facts the upgrade table relies on', () => {
	const fed = actual.cognitoFederated;
	const byPath = (p: string) => Object.entries(fed.resources).find(([, r]) => r.path === `${BLOCK_PATH_PREFIX}${p}`);
	const pool = byPath('cognito-pool/Resource');
	assert.ok(pool, 'the federation pool lives at child id `cognito-pool` (not `pool`)');
	assert.strictEqual(pool[1].physicalName, `${fed.fullId}-federation`);
	const domain = byPath('cognito-pool/domain/Resource');
	assert.ok(domain, 'the hosted-UI domain is a child of `cognito-pool`');
	assert.strictEqual(domain[1].physicalName, 'myapp-abc123');
	assert.ok(byPath('cognito-pool/app-client/Resource'), 'app client at `cognito-pool/app-client`');
	assert.ok(byPath('sessions/table/Resource'), 'session table at `sessions`');

	// Direct mode provisions no Cognito resources at all.
	assert.ok(!Object.values(actual.direct.resources).some((r) => r.Type.startsWith('AWS::Cognito::')));
});
