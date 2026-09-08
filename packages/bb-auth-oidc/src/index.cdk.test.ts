// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side regression test for AuthOIDC's `cognitoFederated()` provider.
 *
 * History (bug #447): the CDK layer registered the federated IdP by writing the
 * client id/secret into `AWS::Cognito::UserPoolIdentityProvider.ProviderDetails`
 * as `{{resolve:ssm-secure:...}}` dynamic references. CloudFormation only allows
 * `ssm-secure` references on a small allowlist that excludes `ProviderDetails`,
 * so `cdk synth` succeeded but every deploy failed at change-set creation —
 * leaving the stack in `REVIEW_IN_PROGRESS` with no resources created. Until the
 * deploy-time custom-resource fix lands, `cognitoFederated()` must fail fast at
 * synth with an actionable message instead of emitting an undeployable template.
 */
import { test, afterEach } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
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

test('CDK: cognitoFederated() surfaces a synth error (undeployable ssm-secure refs, #447)', () => {
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
	// The error names the offending provider and points at the runtime-provider
	// workaround; its presence is what blocks `cdk deploy`.
	Annotations.fromStack(stack).hasError(
		'*',
		Match.stringLikeRegexp("cognitoFederated\\(\\) provider\\(s\\) 'google' cannot be deployed"),
	);
});

test('CDK: a self-hosted provider (google) synthesizes with no such error', () => {
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', {
		providers: [
			google({
				clientId: async () => 'id',
				clientSecret: async () => 'secret',
			}),
		],
	});
	Annotations.fromStack(stack).hasNoError('*', Match.stringLikeRegexp('cannot be deployed'));
});
