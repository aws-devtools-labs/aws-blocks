// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side regression tests for AuthOIDC's `cognitoFederated()` provider.
 *
 * History (bug #447): the CDK layer registered the federated IdP with native
 * `AWS::Cognito::UserPoolIdentityProvider` resources, writing the client
 * id/secret into `ProviderDetails` as `{{resolve:ssm-secure:...}}` dynamic
 * references. CloudFormation only allows `ssm-secure` references on a small
 * allowlist that excludes `ProviderDetails`, so `cdk synth` succeeded but every
 * deploy failed at change-set creation, leaving the stack in
 * `REVIEW_IN_PROGRESS`.
 *
 * Fix: register the IdP through a deploy-time custom resource whose handler
 * reads and decrypts the SecureString parameters via the SDK and calls
 * `CreateIdentityProvider`. The synthesized template therefore contains no
 * native IdP resource and no `ssm-secure` reference — only the parameter names.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Scope, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { AuthOIDC, cognitoFederated, google } from './index.cdk.js';
import type { AppSettingLike } from './providers.js';

class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly id: string;
	constructor(scope: Construct, id: string) {
		super(scope, id);
		this.id = id;
		(globalThis as any).CURRENT_BLOCKS_STACK = this;
		this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
		});
	}
}

afterEach(() => {
	delete (globalThis as any).CURRENT_BLOCKS_STACK;
});

function setup(): { stack: StubBlocksStack; parent: Scope } {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'TestStack');
	const parent = new Scope('app');
	return { stack, parent };
}

// An AppSetting-shaped stub: the CDK layer only reads `fullId`; `get()` is the
// runtime path and is never called at synth.
function appSettingStub(fullId: string): AppSettingLike {
	return { fullId, get: async () => 'unused-at-synth' };
}

function synthFederated(): Template {
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', {
		providers: [
			cognitoFederated({
				name: 'google',
				identityProvider: 'Google',
				cognitoDomain: 'myapp-abc123',
				region: 'us-east-1',
				clientId: appSettingStub('app-google-client-id'),
				clientSecret: appSettingStub('app-google-client-secret'),
			}),
		],
	});
	return Template.fromStack(stack);
}

test('CDK: cognitoFederated() emits NO native IdP resource and NO ssm-secure reference (#447)', () => {
	const template = synthFederated();
	// The bug: a native IdP resource carrying ssm-secure refs in ProviderDetails.
	template.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 0);
	// No ssm-secure dynamic reference anywhere in the synthesized template.
	const json = JSON.stringify(template.toJSON());
	assert.ok(!json.includes('{{resolve:ssm-secure'), 'template must not contain any ssm-secure dynamic reference');
	// The pool itself is still provisioned.
	template.resourceCountIs('AWS::Cognito::UserPool', 1);
});

test('CDK: cognitoFederated() registers the IdP via a custom resource that names (not embeds) the SSM params', () => {
	const template = synthFederated();
	const crs = template.findResources('AWS::CloudFormation::CustomResource');
	const idpCr = Object.values(crs).find(
		(r: any) => r.Properties?.ProviderName === 'Google' && r.Properties?.ProviderType === 'Google',
	) as any;
	assert.ok(idpCr, 'an IdP-registration custom resource should exist');
	// Only the parameter NAMES cross into the template — never the secret values.
	assert.strictEqual(idpCr.Properties.ClientIdParam, '/app-google-client-id');
	assert.strictEqual(idpCr.Properties.ClientSecretParam, '/app-google-client-secret');
	assert.strictEqual(idpCr.Properties.ProviderDetails.authorize_scopes, 'openid email profile');
});

test('CDK: the IdP custom resource depends on BlocksSecretsBulk when present (param exists before the read)', () => {
	// A real BlocksStack has bb-app-setting's shared `BlocksSecretsBulk` resource
	// (it writes every secret AppSetting's SecureString). The plain test stub does
	// not model that, so stand one in with the same construct id; AuthOIDC should
	// wire a dependency onto it so the credential parameters exist before the
	// handler reads them.
	const TOKEN = 'arn:aws:lambda:us-east-1:1:function:x';
	const { stack, parent } = setup();
	new cdk.CustomResource(stack, 'BlocksSecretsBulk', { serviceToken: TOKEN });
	new AuthOIDC(parent, 'auth', {
		providers: [
			cognitoFederated({
				name: 'google', identityProvider: 'Google', cognitoDomain: 'myapp-abc123', region: 'us-east-1',
				clientId: appSettingStub('app-google-client-id'), clientSecret: appSettingStub('app-google-client-secret'),
			}),
		],
	});
	const template = Template.fromStack(stack);
	const crs = template.findResources('AWS::CloudFormation::CustomResource');
	const bulkLogicalId = Object.keys(crs).find((k) => crs[k].Properties?.ServiceToken === TOKEN);
	assert.ok(bulkLogicalId, 'stand-in BlocksSecretsBulk should be in the template');
	const idpEntry = Object.entries(crs).find(([, r]: [string, any]) => r.Properties?.ProviderName === 'Google');
	assert.ok(idpEntry, 'IdP custom resource should exist');
	const dependsOn: string[] = (idpEntry![1] as any).DependsOn ?? [];
	assert.ok(dependsOn.includes(bulkLogicalId as string), 'IdP CR must depend on the bulk secret-init resource');
});

test('CDK: the IdP-registration Lambda is granted cognito-idp, ssm:GetParameter and scoped kms:Decrypt', () => {
	const template = synthFederated();
	// The three grants land across the role's managed statements; assert each
	// independently (kms:ViaService resolves to a region token, so match its
	// presence, not an exact string).
	template.hasResourceProperties('AWS::IAM::Policy', {
		PolicyDocument: {
			Statement: Match.arrayWith([
				Match.objectLike({ Action: Match.arrayWith(['cognito-idp:CreateIdentityProvider']) }),
			]),
		},
	});
	template.hasResourceProperties('AWS::IAM::Policy', {
		PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 'ssm:GetParameter' })]) },
	});
	template.hasResourceProperties('AWS::IAM::Policy', {
		PolicyDocument: {
			Statement: Match.arrayWith([
				Match.objectLike({
					Action: 'kms:Decrypt',
					Condition: Match.objectLike({ StringEquals: Match.objectLike({ 'kms:ViaService': Match.anyValue() }) }),
				}),
			]),
		},
	});
});

test('CDK: a self-hosted provider (google) provisions no Cognito resources', () => {
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', {
		providers: [google({ clientId: async () => 'id', clientSecret: async () => 'secret' })],
	});
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::Cognito::UserPool', 0);
	template.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 0);
});

// Pin the per-provider ProviderType + ProviderDetails so a future edit can't
// silently drift them away from what the old L2 constructs produced.
function idpProps(provider: Parameters<typeof cognitoFederated>[0]): any {
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', { providers: [cognitoFederated(provider)] });
	const crs = Template.fromStack(stack).findResources('AWS::CloudFormation::CustomResource');
	return Object.values(crs).find((r: any) => r.Properties?.ProviderType && r.Properties?.ClientIdParam) as any;
}

test('CDK: Facebook provider maps to ProviderType=Facebook, scopes "public_profile email"', () => {
	const cr = idpProps({
		name: 'fb', identityProvider: 'Facebook', cognitoDomain: 'd1', region: 'us-east-1',
		clientId: appSettingStub('fb-id'), clientSecret: appSettingStub('fb-secret'),
	});
	assert.strictEqual(cr.Properties.ProviderType, 'Facebook');
	assert.strictEqual(cr.Properties.ProviderDetails.authorize_scopes, 'public_profile email');
});

test('CDK: LoginWithAmazon provider maps to ProviderType=LoginWithAmazon, scopes "profile"', () => {
	const cr = idpProps({
		name: 'amzn', identityProvider: 'LoginWithAmazon', cognitoDomain: 'd2', region: 'us-east-1',
		clientId: appSettingStub('amzn-id'), clientSecret: appSettingStub('amzn-secret'),
	});
	assert.strictEqual(cr.Properties.ProviderType, 'LoginWithAmazon');
	assert.strictEqual(cr.Properties.ProviderDetails.authorize_scopes, 'profile');
});

test('CDK: a custom OIDC provider maps to ProviderType=OIDC with oidc_issuer + GET', () => {
	const cr = idpProps({
		name: 'corp', identityProvider: 'CorpIdP', idpIssuerUrl: 'https://idp.example.com',
		cognitoDomain: 'd3', region: 'us-east-1',
		clientId: appSettingStub('corp-id'), clientSecret: appSettingStub('corp-secret'),
	});
	assert.strictEqual(cr.Properties.ProviderType, 'OIDC');
	assert.strictEqual(cr.Properties.ProviderDetails.oidc_issuer, 'https://idp.example.com');
	assert.strictEqual(cr.Properties.ProviderDetails.attributes_request_method, 'GET');
});

test('CDK: two providers with the same identityProvider fail fast at synth', () => {
	const { parent } = setup();
	assert.throws(
		() => new AuthOIDC(parent, 'auth', {
			providers: [
				cognitoFederated({
					name: 'g1', identityProvider: 'Google', cognitoDomain: 'd', region: 'us-east-1',
					clientId: appSettingStub('g1-id'), clientSecret: appSettingStub('g1-secret'),
				}),
				cognitoFederated({
					name: 'g2', identityProvider: 'Google', cognitoDomain: 'd', region: 'us-east-1',
					clientId: appSettingStub('g2-id'), clientSecret: appSettingStub('g2-secret'),
				}),
			],
		}),
		/duplicate cognitoFederated identityProvider 'Google'/,
	);
});
