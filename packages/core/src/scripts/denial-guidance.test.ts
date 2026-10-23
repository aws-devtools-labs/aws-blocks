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

describe('classifyDenialError', () => {
	for (const [name, message, expected] of [
		['AccessDenied', SCP_DENY, 'organization-policy'],
		['AccessDeniedException', SCP_DENY_WITH_ARN, 'organization-policy'],
		['AccessDeniedException', RCP_DENY, 'organization-policy'],
		['AccessDeniedException', IDENTITY_DENY, 'denied'],
		['AccessDenied', 'Access Denied', 'denied'],
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
	] as const) {
		it(`classifies ${name} as ${expected}`, () => {
			assert.strictEqual(classifyDenialText(text), expected);
		});
	}

	for (const text of [
		'Resource handler returned message: "app-bucket already exists (Service: S3, Status Code: 409)"',
		'cdk deploy exited with code 1',
		'',
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
