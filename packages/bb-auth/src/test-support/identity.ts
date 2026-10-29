// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resource-identity extraction for the CDK tests (test-only).
 *
 * The extraction is the same as B1's `bb-auth-cognito/src/resource-identity.cdk.test.ts`
 * (copied, since packages can't share test sources; `bb-auth-cognito` was deleted
 * at the cutover), so an `Auth` identity is directly comparable with the
 * `AuthCognito` golden fixture.
 */

import { cognitoConfigKeys, sessionCookieName } from '../cdk/contract.js';
import { type CdkSynthResult, type CfnTemplateJson, synthUnderCdkConditions } from './cdk-synth.js';

/** The construct whose subtree is the block's (a `BlocksStack` id + the block id). */
export const BLOCK_PATH_PREFIX = 'TestStack/auth/';

/**
 * Stack-level shared resources the block depends on. `BlocksSecretsBulk`
 * (bb-app-setting) owns the `session-secret` SSM SecureString: if its logical ID
 * changed, CloudFormation would delete every parameter it manages — the session
 * HMAC secret included, signing every user out.
 */
export const SHARED_LOGICAL_IDS = ['BlocksSecretsBulk'];

export interface PinnedResource {
	Type: string;
	/** The construct path (`aws:cdk:path`) — for humans; identity is the logical ID. */
	path: string;
	/** The resource's physical name where the template sets one, else `null`. */
	physicalName: string | string[] | null;
}

/** One pinned variant — the shape of an entry in `__fixtures__/authcognito-resource-identity.json`. */
export interface VariantIdentity {
	/** The customer code being pinned (a label; not part of the deployed identity). */
	construct: string;
	fullId: string;
	userPoolName: string | null;
	sessionCookieName: string;
	/** `BLOCKS_AUTH_COGNITO_*` config keys → resolved values (tokens show the logical ID they point at). */
	configKeys: Record<string, unknown>;
	/** Keyed by logical ID. */
	resources: Record<string, PinnedResource>;
}

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

export function pinnedResources(template: CfnTemplateJson): Record<string, PinnedResource> {
	const out: Record<string, PinnedResource> = {};
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

export interface SynthesizedAuth extends CdkSynthResult {
	identity: VariantIdentity;
}

/**
 * Synth `construct` (an expression building the block with id `auth` on `stack`;
 * `Auth` and `AppSetting` are in scope, plus anything `extraImports` brings in)
 * and extract its identity.
 */
export function synthIdentity(
	construct: string,
	preset?: 'sandbox' | 'production',
	extraImports: readonly string[] = [],
): SynthesizedAuth {
	const result = synthUnderCdkConditions({
		imports: [
			"import { Auth } from '@aws-blocks/bb-auth';",
			// For provider secrets, which must be real `secret: true` AppSettings.
			"import { AppSetting } from '@aws-blocks/bb-app-setting';",
			...extraImports,
		].join('\n'),
		build: `const auth = ${construct};\nreport.fullId = auth.fullId;`,
		preset,
	});
	const fullId = String(result.report.fullId);
	const pools = Object.values(result.template.Resources).filter((r) => r.Type === 'AWS::Cognito::UserPool');
	const configKeys: Record<string, unknown> = {};
	for (const key of Object.keys(result.config).sort()) {
		if (key.startsWith('BLOCKS_AUTH_COGNITO_')) configKeys[key] = result.config[key];
	}
	return {
		...result,
		identity: {
			construct,
			fullId,
			userPoolName: pools.length === 1 ? String(pools[0].Properties?.UserPoolName) : null,
			sessionCookieName: sessionCookieName(fullId),
			configKeys,
			resources: pinnedResources(result.template),
		},
	};
}

function describeResource(logicalId: string, r: PinnedResource): string {
	return `${logicalId}  (${r.Type}, construct path ${r.path}, physicalName ${JSON.stringify(r.physicalName)})`;
}

/** Human-readable, per-resource identity diff (B1's format). Empty when identical. `construct` is a label and is ignored. */
export function diffIdentity(expected: VariantIdentity, actual: VariantIdentity): string[] {
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

/** The `BLOCKS_AUTH_COGNITO_*` keys for `fullId`, sorted — what `Auth` registers when a pool exists. */
export function expectedConfigKeys(fullId: string): string[] {
	return Object.values(cognitoConfigKeys(fullId)).sort();
}
