// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { classifyDenialError, classifyDenialText, denialGuidance } from './denial-guidance.js';
import { DeployProcessError } from './deploy-stream.js';

/** Build an Error with a specific `name`, as the AWS SDK throws. */
function namedError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

// Message formats from the IAM "Troubleshoot access denied error messages" guide.
const USER = 'User: arn:aws:sts::123456789012:assumed-role/Deploy/session';
const SCP_DENY = `${USER} is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::123456789012:role/cdk-hnb659fds-deploy-role with an explicit deny in a service control policy`;
const SCP_DENY_WITH_ARN = `${USER} is not authorized to perform: lambda:CreateFunction with an explicit deny in a service control policy: arn:aws:organizations::777788889999:policy/o-exampleorgid/service_control_policy/p-examplepolicyid123`;
const RCP_DENY = `${USER} is not authorized to perform: secretsmanager:GetSecretValue on resource: arn:aws:secretsmanager:us-east-1:123456789012:secret:* with an explicit deny in a resource control policy`;
const IDENTITY_DENY = `${USER} is not authorized to perform: ssm:GetParameter on resource: arn:aws:ssm:us-east-1:123456789012:parameter/app because no identity-based policy allows the ssm:GetParameter action`;
const IMPLICIT_SCP_DENY = `${USER} is not authorized to perform: codecommit:ListRepositories because no service control policy allows the codecommit:ListRepositories action`;

// CDK's DeploymentError block for a CloudFormation resource that an SCP denied, as
// the CDK CLI prints it: the reason is hard-wrapped mid-phrase, so neither the
// explicit-deny phrase nor "is not authorized to perform" is on one line.
const EXEC_ROLE =
	'arn:aws:sts::123456789012:assumed-role/cdk-hnb659fds-cfn-exec-role-123456789012-us-east-1/AWSCloudFormation';
const WRAPPED_SCP_DENY = [
	'‣ DeploymentError: Resource updates failed:',
	'my-app-prod/DefaultCompute/API/Resource  (AWS::ApiGateway::RestApi DefaultComputeAPI5E5CE44A)',
	'  Resource handler returned message: "User:',
	`  ${EXEC_ROLE} is not`,
	'  authorized to perform: apigateway:POST on resource: arn:aws:apigateway:us-east-1::/restapis with an explicit deny in a',
	'  service control policy: arn:aws:organizations::777788889999:policy/o-exampleorgid/service_control_policy/p-examplepolicyid123',
	'  (Service: ApiGateway, Status Code: 403, Request ID: 11111111-2222-3333-4444-555555555555) (SDK Attempt Count: 1)"',
	'  (RequestToken: 66666666-7777-8888-9999-000000000000, HandlerErrorCode: GeneralServiceException)',
];
// The notes that the CDK CLI prints after a failure. Each names AccessDenied only as an example.
const CDK_DIAGNOSE_HINT =
	'   CloudTrail delivery can lag up to 15 minutes behind the failure; re-run `cdk diagnose` in a few minutes to check for additional control-plane errors (e.g. AccessDenied).';
const CDK_LOOKUP_HINT =
	'Could not query CloudTrail for control-plane errors: the lookup role is missing the `cloudtrail:LookupEvents` permission. Grant it to surface errors (e.g. AccessDenied) that resource logs may not show.';
const EC2_SCP_DENY = `You are not authorized to perform this operation. User: ${USER.slice(6)} is not authorized to perform: ec2:RunInstances on resource: arn:aws:ec2:us-east-1:123456789012:instance/* with an explicit deny in a service control policy. Encoded authorization failure message: example`;
const SNS_SCP_DENY = `${USER} is not authorized to perform: SNS:CreateTopic on resource: arn:aws:sns:us-east-1:123456789012:app-topic with an explicit deny in a service control policy`;

describe('classifyDenialError', () => {
	for (const [name, message, expected] of [
		['AccessDenied', SCP_DENY, 'organization-policy'],
		['AccessDeniedException', SCP_DENY_WITH_ARN, 'organization-policy'],
		['AccessDeniedException', RCP_DENY, 'organization-policy'],
		['AccessDeniedException', IDENTITY_DENY, 'denied'],
		['AccessDenied', 'Access Denied', 'denied'],
		['UnauthorizedOperation', EC2_SCP_DENY, 'organization-policy'],
		['UnauthorizedOperation', 'You are not authorized to perform this operation.', 'denied'],
		['AuthorizationError', SNS_SCP_DENY, 'organization-policy'],
		['AuthorizationError', IDENTITY_DENY, 'denied'],
	] as const) {
		it(`classifies ${name}: ${message.slice(-60)} as ${expected}`, () => {
			assert.strictEqual(classifyDenialError(namedError(name, message)), expected);
		});
	}

	it('treats a denial because no service control policy allows the action as an ordinary denial', () => {
		// The documented explicit-deny phrase is the only evidence of an organization policy.
		assert.strictEqual(classifyDenialError(namedError('AccessDenied', IMPLICIT_SCP_DENY)), 'denied');
	});

	it('reads only SDK denial errors, whatever their message says', () => {
		for (const error of [
			namedError('ThrottlingException', SCP_DENY),
			namedError('CredentialsProviderError', SCP_DENY),
			new Error(SCP_DENY),
			new DeployProcessError('cdk deploy exited with code 1', { exitCode: 1 }),
		]) {
			assert.strictEqual(classifyDenialError(error), undefined, error.name);
		}
		assert.strictEqual(classifyDenialError(SCP_DENY), undefined);
		assert.strictEqual(classifyDenialError(undefined), undefined);
	});
});

describe('classifyDenialText', () => {
	for (const [name, text, expected] of [
		['a CDK error line', `❌  app-sandbox failed: AccessDenied: ${SCP_DENY}`, 'organization-policy'],
		[
			'a CloudFormation resource failure event',
			`app-sandbox | 3:04:05 PM | CREATE_FAILED | AWS::Lambda::Function | Handler Resource handler returned message: "${SCP_DENY_WITH_ARN} (Service: Lambda, Status Code: 403, Request ID: 1a2b3c4d)"`,
			'organization-policy',
		],
		['a resource control policy denial with a CRLF line ending', `${RCP_DENY}\r\n`, 'organization-policy'],
		['an identity-based policy denial', `AccessDeniedException: ${IDENTITY_DENY}`, 'denied'],
		['a denial because no service control policy allows the action', IMPLICIT_SCP_DENY, 'denied'],
		[
			'an S3 Access Denied',
			'Resource handler returned message: "Access Denied (Service: S3, Status Code: 403)"',
			'denied',
		],
		['a hard-wrapped CDK DeploymentError block', WRAPPED_SCP_DENY.join('\n'), 'organization-policy'],
		['a hard-wrapped block with CRLF line endings', WRAPPED_SCP_DENY.join('\r\n'), 'organization-policy'],
		[
			'a colored CDK error line',
			`\u001b[33m‣ AccessDenied: ${SCP_DENY.replace('explicit deny', '\u001b[1mexplicit\u001b[22m deny')}\u001b[39m`,
			'organization-policy',
		],
		[
			'a KMS denial that names no policy',
			`Resource handler returned message: "Access denied for operation 'CreateKey'." (RequestToken: 66666666-7777-8888-9999-000000000000, HandlerErrorCode: AccessDenied)`,
			'denied',
		],
		['an EC2 denial', 'UnauthorizedOperation: You are not authorized to perform this operation.', 'denied'],
		['an SNS denial', `AuthorizationError: ${SNS_SCP_DENY}`, 'organization-policy'],
		[
			'a denial next to the CDK diagnose hint',
			`${WRAPPED_SCP_DENY.join('\n')}\n\n${CDK_DIAGNOSE_HINT}`,
			'organization-policy',
		],
	] as const) {
		it(`classifies ${name} as ${expected}`, () => {
			assert.strictEqual(classifyDenialText(text), expected);
		});
	}

	for (const text of [
		'Resource handler returned message: "app-bucket already exists (Service: S3, Status Code: 409)"',
		'cdk deploy exited with code 1',
		'',
		CDK_DIAGNOSE_HINT,
		// The same hint, wrapped where a narrower terminal would break it.
		CDK_DIAGNOSE_HINT.replace('(e.g. ', '(e.g.\n   '),
		CDK_LOOKUP_HINT,
		'ExpiredToken: The security token included in the request is expired',
		'Resource handler returned message: "Rate exceeded (Service: Lambda, Status Code: 429)"',
	]) {
		it(`does not classify ${JSON.stringify(text)}`, () => {
			assert.strictEqual(classifyDenialText(text), undefined);
		});
	}
});

describe('denialGuidance', () => {
	it('explains an organization policy without attributing it to a spending limit', () => {
		const text = denialGuidance('organization-policy').join('\n');
		assert.match(text, /AWS Organizations policy/);
		assert.match(text, /service control policy or a resource control policy/);
		assert.doesNotMatch(text, /limit|budget|spend|cost/i);
	});

	it('points an ordinary denial at the permissions of the deploying identity', () => {
		const text = denialGuidance('denied').join('\n');
		assert.match(text, /permissions/);
		assert.doesNotMatch(text, /Organizations/);
	});

	it('never contains error details', () => {
		for (const kind of ['organization-policy', 'denied'] as const) {
			assert.doesNotMatch(denialGuidance(kind).join('\n'), /arn:|\d{12}|o-[a-z0-9]+|p-[a-z0-9]+/);
		}
	});
});
