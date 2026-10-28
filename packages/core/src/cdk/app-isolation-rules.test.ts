// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import {
	APP_ID_PATTERN,
	checkLayer,
	checkResourcePolicy,
	checkRole,
	checkStatement,
	checkTransforms,
} from './app-isolation-rules.js';

const rules = (violations: { rule: string }[]) => violations.map((v) => v.rule);
const ssmArn = (name: string) => ({
	'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':ssm:', { Ref: 'AWS::Region' }, ':', { Ref: 'AWS::AccountId' }, `:parameter/${name}`]],
});

describe('app-isolation rules — statements fail closed', () => {
	test('an app id is at most 10 characters (CDK qualifier limit)', () => {
		assert.ok(APP_ID_PATTERN.test('inventory1'));
		assert.ok(!APP_ID_PATTERN.test('inventoryab'));
	});

	test('NotResource on a data service is an inverse grant', () => {
		const s = { Effect: 'Allow', Action: 'ssm:GetParameter', NotResource: ssmArn('appa-x') };
		assert.deepStrictEqual(rules(checkStatement(s, 'appa', 'p')), ['inverse-grant']);
	});

	test('NotAction is an inverse grant', () => {
		const s = { Effect: 'Allow', NotAction: 'iam:*', Resource: '*' };
		assert.deepStrictEqual(rules(checkStatement(s, 'appa', 'p')), ['inverse-grant']);
	});

	test('Fn::ImportValue, a template parameter, and Fn::Sub on a parameter are unresolvable', () => {
		const params = new Set(['OtherSecret']);
		for (const resource of [
			{ 'Fn::ImportValue': 'appb-secret-arn' },
			{ Ref: 'OtherSecret' },
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a CloudFormation Fn::Sub string, not a template
			{ 'Fn::Sub': 'arn:aws:ssm:us-east-1:111111111111:parameter/${OtherSecret}' },
		]) {
			const s = { Effect: 'Allow', Action: 'ssm:GetParameter', Resource: resource };
			assert.deepStrictEqual(rules(checkStatement(s, 'appa', 'p', params)), ['unresolvable-grant'], JSON.stringify(resource));
		}
	});

	test("a reference to the template's own resource is the app's own", () => {
		const s = { Effect: 'Allow', Action: 'dynamodb:GetItem', Resource: { 'Fn::GetAtt': ['Table', 'Arn'] } };
		assert.deepStrictEqual(checkStatement(s, 'appa', 'p'), []);
	});

	test('a condition that doesn’t scope by resource tag doesn’t exempt a wildcard', () => {
		const s = {
			Effect: 'Allow',
			Action: 'dynamodb:GetItem',
			Resource: '*',
			Condition: { Bool: { 'aws:SecureTransport': 'true' } },
		};
		assert.deepStrictEqual(rules(checkStatement(s, 'appa', 'p')), ['wildcard-data-grant']);
		const tagged = { ...s, Condition: { StringEquals: { 'aws:ResourceTag/app': 'appa' } } };
		assert.deepStrictEqual(checkStatement(tagged, 'appa', 'p'), []);
	});

	test("a condition for everything except this app, or for another app, doesn't exempt a wildcard", () => {
		for (const Condition of [
			{ StringNotEquals: { 'aws:ResourceTag/app': 'appa' } },
			{ StringEquals: { 'aws:ResourceTag/app': 'appb' } },
			{ StringEquals: { 'aws:ResourceTag/app': ['appa', 'appb'] } },
			{ StringLike: { 'aws:ResourceTag/app': '*' } },
		]) {
			const s = { Effect: 'Allow', Action: 'dynamodb:GetItem', Resource: '*', Condition };
			assert.deepStrictEqual(rules(checkStatement(s, 'appa', 'p')), ['wildcard-data-grant'], JSON.stringify(Condition));
		}
		const variable = { StringEquals: { 'aws:ResourceTag/app': '$' + '{aws:PrincipalTag/app}' } };
		assert.deepStrictEqual(checkStatement({ Effect: 'Allow', Action: 'states:*', Resource: '*', Condition: variable }, 'appa', 'p'), []);
	});

	test('kms:ViaService exempts a KMS wildcard only for fenced services, and only for KMS actions', () => {
		const region = { 'Fn::Join': ['', ['ssm.', { Ref: 'AWS::Region' }, '.amazonaws.com']] };
		const kms = (via: unknown, Action: string | string[] = ['kms:Decrypt']) => ({
			Effect: 'Allow',
			Action,
			Resource: '*',
			Condition: { StringEquals: { 'kms:ViaService': via } },
		});
		assert.deepStrictEqual(checkStatement(kms(region), 'appa', 'p'), []);
		assert.deepStrictEqual(rules(checkStatement(kms('ec2.us-east-1.amazonaws.com'), 'appa', 'p')), ['wildcard-data-grant']);
		assert.deepStrictEqual(rules(checkStatement(kms(region, ['kms:Decrypt', 'dynamodb:GetItem']), 'appa', 'p')), ['wildcard-data-grant']);
	});

	test('a template transform or Fn::Transform is flagged', () => {
		assert.deepStrictEqual(rules(checkTransforms({ Transform: 'AWS::Serverless-2016-10-31' }, 't')), ['template-transform']);
		assert.deepStrictEqual(
			rules(checkTransforms({ Resources: { X: { Properties: { 'Fn::Transform': { Name: 'AWS::Include' } } } } }, 't')),
			['template-transform'],
		);
		assert.deepStrictEqual(
			rules(checkTransforms({ Outputs: { O: { Value: { 'Fn::Transform': { Name: 'Macro' } } } } }, 't')),
			['template-transform'],
			'any section of the template',
		);
		assert.deepStrictEqual(checkTransforms({ Resources: { X: { Type: 'AWS::SQS::Queue' } } }, 't'), []);
	});

	test("lambda:UpdateFunctionCode and GetFunction on another app's function are flagged", () => {
		for (const action of ['lambda:UpdateFunctionCode', 'lambda:GetFunction']) {
			const s = { Effect: 'Allow', Action: action, Resource: 'arn:aws:lambda:us-east-1:111111111111:function:appb-Handler' };
			assert.deepStrictEqual(rules(checkStatement(s, 'appa', 'p')), ['grant-outside-app'], action);
		}
	});

	test("another app's CDK asset bucket is outside; the app's own is inside", () => {
		const read = (bucket: string) => ({ Effect: 'Allow', Action: 's3:GetObject', Resource: `arn:aws:s3:::${bucket}/*` });
		assert.deepStrictEqual(checkStatement(read('cdk-appa-assets-111111111111-us-east-1'), 'appa', 'p'), []);
		assert.deepStrictEqual(rules(checkStatement(read('cdk-appb-assets-111111111111-us-east-1'), 'appa', 'p')), ['grant-outside-app']);
	});
});

describe('app-isolation rules — layers and APIs', () => {
	test("a layer named outside the prefix, or with no name, is flagged; the app's own is fine", () => {
		assert.deepStrictEqual(checkLayer({ LayerName: 'appa-AwsCliLayer' }, 'appa', 'p'), []);
		assert.deepStrictEqual(rules(checkLayer({ LayerName: 'appb-AwsCliLayer' }, 'appa', 'p')), ['layer-outside-app']);
		assert.deepStrictEqual(rules(checkLayer({}, 'appa', 'p')), ['layer-outside-app']);
	});

	test('execute-api on * is a wildcard grant', () => {
		const s = { Effect: 'Allow', Action: 'execute-api:ManageConnections', Resource: 'arn:aws:execute-api:us-east-1:111111111111:*' };
		assert.deepStrictEqual(rules(checkStatement({ ...s, Resource: '*' }, 'appa', 'p')), ['wildcard-data-grant']);
	});
});

describe('app-isolation rules — resource policies and trust', () => {
	test("a Lambda permission or queue policy on another app's resource is flagged", () => {
		assert.deepStrictEqual(
			rules(checkResourcePolicy('AWS::Lambda::Permission', { FunctionName: 'appb-Handler' }, 'appa', 'p')),
			['resource-policy-outside-app'],
		);
		assert.deepStrictEqual(
			rules(checkResourcePolicy('AWS::SQS::QueuePolicy', { Queues: ['https://sqs.us-east-1.amazonaws.com/111111111111/appb-jobs'] }, 'appa', 'p')),
			['resource-policy-outside-app'],
		);
		assert.deepStrictEqual(checkResourcePolicy('AWS::Lambda::Permission', { FunctionName: { 'Fn::GetAtt': ['Fn', 'Arn'] } }, 'appa', 'p'), []);
		assert.deepStrictEqual(checkResourcePolicy('AWS::S3::BucketPolicy', { Bucket: 'appa-files' }, 'appa', 'p'), []);
	});

	test('a role that trusts an account or a federated identity is flagged; a service principal is fine', () => {
		const role = (Principal: unknown) => ({
			AssumeRolePolicyDocument: { Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal }] },
			Tags: [{ Key: 'app', Value: 'appa' }],
		});
		assert.deepStrictEqual(rules(checkRole(role({ AWS: 'arn:aws:iam::222222222222:root' }), 'appa', 'p', false)), ['role-trust-not-service']);
		assert.deepStrictEqual(rules(checkRole(role('*'), 'appa', 'p', false)), ['role-trust-not-service']);
		assert.deepStrictEqual(checkRole(role({ Service: 'lambda.amazonaws.com' }), 'appa', 'p', false), []);
	});
});
