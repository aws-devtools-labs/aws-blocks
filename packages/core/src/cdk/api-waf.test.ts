// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `apiWaf`: prop validation, and where the front-door aspect
 * attaches the web ACL for each topology (gateway stage, managed distribution,
 * or nowhere when Hosting fronts the API).
 */
import assert from 'node:assert';
import { describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import {
	type ApiFrontDoorOwner,
	apiFrontDoorMarker,
	claimApiFrontDoor,
	publishPublicOrigin,
	scheduleApiFrontDoor,
} from './api-front-door.js';
import {
	API_FRONT_DOOR_MARKER_HEADER,
	API_WAF_DEFERRED_WARNING,
	API_WAF_NO_RATE_LIMIT_WARNING,
	apiFrontDoorMarkerValue,
	type ResolvedApiWaf,
	resolveApiWaf,
} from './api-waf.js';

const GATEWAY_URL = 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api';
const REGIONAL_ACL = 'arn:aws:wafv2:us-east-1:111122223333:regional/webacl/mine/abcd';
const CLOUDFRONT_ACL = 'arn:aws:wafv2:us-east-1:111122223333:global/webacl/mine/abcd';

/** A stack standing in for the backend owner, with a real REST API stage to attach to. */
function owner(waf: ResolvedApiWaf | undefined, region = 'us-east-1'): {
	stack: cdk.Stack & ApiFrontDoorOwner;
	stage: cdk.aws_apigateway.Stage;
} {
	const stack: cdk.Stack & ApiFrontDoorOwner = new cdk.Stack(new cdk.App(), 'S', { env: { region } });
	stack._apiWaf = waf;
	const api = new cdk.aws_apigateway.RestApi(stack, 'Api');
	api.root.addMethod('ANY');
	return { stack, stage: api.deploymentStage };
}

describe('resolveApiWaf', () => {
	test('off unless enabled or a webAclArn is given', () => {
		assert.strictEqual(resolveApiWaf(undefined), undefined);
		assert.strictEqual(resolveApiWaf({}), undefined);
		assert.strictEqual(resolveApiWaf({ enabled: false }), undefined);
	});

	test('enabled defaults the rate limit to 1000 and keeps an explicit one', () => {
		assert.deepStrictEqual(resolveApiWaf({ enabled: true }), { rateLimit: 1000 });
		assert.deepStrictEqual(resolveApiWaf({ enabled: true, rateLimit: 250 }), { rateLimit: 250 });
	});

	test('webAclArn is used as-is', () => {
		assert.deepStrictEqual(resolveApiWaf({ webAclArn: REGIONAL_ACL }), { webAclArn: REGIONAL_ACL });
	});

	test('rejects contradictory or invalid settings', () => {
		assert.throws(() => resolveApiWaf({ webAclArn: REGIONAL_ACL, enabled: true }), /either \{ webAclArn \}/);
		assert.throws(() => resolveApiWaf({ webAclArn: REGIONAL_ACL, rateLimit: 500 }), /either \{ webAclArn \}/);
		assert.throws(() => resolveApiWaf({ webAclArn: '' }), /non-empty web ACL ARN/);
		for (const rateLimit of [99, 0, 150.5]) {
			assert.throws(() => resolveApiWaf({ enabled: true, rateLimit }), /at least 100/);
		}
		assert.throws(() => resolveApiWaf({ rateLimit: 500 }), /only applies with enabled: true/);
		// A JS caller can pass a non-object; the cast is test-only plumbing.
		assert.throws(() => resolveApiWaf(true as unknown as undefined), /must be an object/);
	});
});

describe('apiWaf placement (front-door aspect)', () => {
	test('apigateway: a REGIONAL web ACL is associated with the REST API stage', () => {
		const { stack, stage } = owner({ rateLimit: 1000 });
		scheduleApiFrontDoor(stack, false, GATEWAY_URL, stage);
		const template = Template.fromStack(stack);
		template.hasResourceProperties('AWS::WAFv2::WebACL', { Scope: 'REGIONAL' });
		template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
		const [assoc] = Object.values(template.findResources('AWS::WAFv2::WebACLAssociation'));
		assert.match(JSON.stringify(assoc.Properties.ResourceArn), /restapis/, 'associated with the API stage ARN');
		template.resourceCountIs('AWS::CloudFront::Distribution', 0);
	});

	test('apigateway: works outside us-east-1 (REGIONAL scope has no region constraint)', () => {
		const { stack, stage } = owner({ rateLimit: 1000 }, 'eu-west-1');
		scheduleApiFrontDoor(stack, false, GATEWAY_URL, stage);
		Template.fromStack(stack).resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
	});

	test('apigateway: a bring-your-own web ACL is associated without creating one', () => {
		const { stack, stage } = owner({ webAclArn: REGIONAL_ACL });
		scheduleApiFrontDoor(stack, false, GATEWAY_URL, stage);
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::WAFv2::WebACL', 0);
		template.hasResourceProperties('AWS::WAFv2::WebACLAssociation', { WebACLArn: REGIONAL_ACL });
	});

	test('cloudfront: a CLOUDFRONT web ACL is set on the managed distribution', () => {
		const { stack, stage } = owner({ rateLimit: 1000 });
		scheduleApiFrontDoor(stack, true, GATEWAY_URL, stage);
		const template = Template.fromStack(stack);
		template.hasResourceProperties('AWS::WAFv2::WebACL', { Scope: 'CLOUDFRONT' });
		template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
		template.hasResourceProperties('AWS::CloudFront::Distribution', {
			DistributionConfig: { WebACLId: { 'Fn::GetAtt': [Match.stringLikeRegexp('ApiWaf'), 'Arn'] } },
		});
	});

	test('cloudfront: a bring-your-own web ACL is set on the distribution in any region', () => {
		const { stack, stage } = owner({ webAclArn: CLOUDFRONT_ACL }, 'eu-west-1');
		scheduleApiFrontDoor(stack, true, GATEWAY_URL, stage);
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::WAFv2::WebACL', 0);
		template.hasResourceProperties('AWS::CloudFront::Distribution', {
			DistributionConfig: { WebACLId: CLOUDFRONT_ACL },
		});
	});

	test('cloudfront: enabled outside us-east-1 fails synth with a way out', () => {
		const { stack, stage } = owner({ rateLimit: 1000 }, 'eu-west-1');
		scheduleApiFrontDoor(stack, true, GATEWAY_URL, stage);
		assert.throws(
			() => Template.fromStack(stack),
			(err: Error) => /only\s+creates in us-east-1/.test(err.message) && /apiWaf: \{ webAclArn \}/.test(err.message),
		);
	});

	test('claimed by Hosting: creates nothing and warns', () => {
		const { stack, stage } = owner({ rateLimit: 1000 });
		claimApiFrontDoor(stack, 'https://d111.cloudfront.net');
		scheduleApiFrontDoor(stack, true, GATEWAY_URL, stage);
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::WAFv2::WebACL', 0);
		template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
		const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('apiWaf creates no web ACL'));
		assert.strictEqual(warnings.length, 1);
		assert.match(String(warnings[0].entry.data), new RegExp(API_WAF_DEFERRED_WARNING));
	});

	test('off: no WAF resources and no warning, in every topology', () => {
		for (const provision of [true, false]) {
			const { stack, stage } = owner(undefined);
			scheduleApiFrontDoor(stack, provision, GATEWAY_URL, stage);
			const template = Template.fromStack(stack);
			template.resourceCountIs('AWS::WAFv2::WebACL', 0);
			template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
		}
	});

	test('the managed web ACL counts (does not block) the Common body rules and rate-limits per IP', () => {
		const { stack, stage } = owner({ rateLimit: 2000 });
		scheduleApiFrontDoor(stack, false, GATEWAY_URL, stage);
		const [acl] = Object.values(Template.fromStack(stack).findResources('AWS::WAFv2::WebACL'));
		const rules = acl.Properties.Rules as Array<Record<string, any>>;
		const common = rules.find((r) => r.Name === 'AWSManagedRulesCommonRuleSet');
		assert.deepStrictEqual(
			common?.Statement.ManagedRuleGroupStatement.RuleActionOverrides,
			['SizeRestrictions_BODY', 'CrossSiteScripting_BODY', 'GenericLFI_BODY', 'GenericRFI_BODY'].map((Name) => ({
				Name,
				ActionToUse: { Count: {} },
			})),
		);
		assert.ok(rules.some((r) => r.Name === 'AWSManagedRulesKnownBadInputsRuleSet'));
		const rate = rules.find((r) => r.Name === 'RateLimitRule');
		assert.deepStrictEqual(rate?.Statement.RateBasedStatement, { Limit: 2000, AggregateKeyType: 'IP' });
		assert.deepStrictEqual(rate?.Action, { Block: {} });
	});

	test('apigateway + a claiming CloudFront Hosting: the stage ACL keeps a rate rule that exempts marked requests', () => {
		const { stack, stage } = owner({ rateLimit: 1000 });
		claimApiFrontDoor(stack, 'https://d111.cloudfront.net');
		const marker = apiFrontDoorMarker(stack);
		assert.deepStrictEqual(marker, { [API_FRONT_DOOR_MARKER_HEADER]: apiFrontDoorMarkerValue(stack) });
		scheduleApiFrontDoor(stack, false, GATEWAY_URL, stage);
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
		const [acl] = Object.values(template.findResources('AWS::WAFv2::WebACL'));
		const rate = (acl.Properties.Rules as Array<Record<string, any>>).find((r) => r.Name === 'RateLimitRule');
		assert.deepStrictEqual(rate?.Statement.RateBasedStatement.ScopeDownStatement, {
			NotStatement: {
				Statement: {
					ByteMatchStatement: {
						FieldToMatch: { SingleHeader: { Name: API_FRONT_DOOR_MARKER_HEADER } },
						PositionalConstraint: 'EXACTLY',
						SearchString: apiFrontDoorMarkerValue(stack),
						TextTransformations: [{ Priority: 0, Type: 'NONE' }],
					},
				},
			},
		});
		assert.strictEqual(Annotations.fromStack(stack).findWarning('*', Match.anyValue()).length, 0);
	});

	test('apigateway + a proxying Hosting door: the stage ACL has no rate rule, and synth warns', () => {
		for (const front of ['published', 'claimed-unmarked'] as const) {
			const { stack, stage } = owner({ rateLimit: 1000 });
			// A non-claiming door (ALB, API Gateway, BYO) publishes the browser origin;
			// a CloudFront edge over a router claims without forwarding the marker.
			if (front === 'published') publishPublicOrigin(stack);
			else claimApiFrontDoor(stack, 'https://d111.cloudfront.net');
			scheduleApiFrontDoor(stack, false, GATEWAY_URL, stage);
			const template = Template.fromStack(stack);
			template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
			const [acl] = Object.values(template.findResources('AWS::WAFv2::WebACL'));
			const names = (acl.Properties.Rules as Array<{ Name: string }>).map((r) => r.Name);
			assert.deepStrictEqual(names, ['AWSManagedRulesCommonRuleSet', 'AWSManagedRulesKnownBadInputsRuleSet'], front);
			const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('leaves the per-IP rate rule off'));
			assert.strictEqual(warnings.length, 1, front);
			assert.match(String(warnings[0].entry.data), new RegExp(API_WAF_NO_RATE_LIMIT_WARNING));
		}
	});

	test('the marker is only offered for a Blocks-managed web ACL', () => {
		assert.strictEqual(apiFrontDoorMarker(owner(undefined).stack), undefined);
		assert.strictEqual(apiFrontDoorMarker(owner({ webAclArn: REGIONAL_ACL }).stack), undefined);
	});

	test('the marker value is stable across synths and differs per backend', () => {
		assert.strictEqual(apiFrontDoorMarkerValue(owner(undefined).stack), apiFrontDoorMarkerValue(owner(undefined).stack));
		const a = new cdk.Stack(new cdk.App(), 'A');
		const b = new cdk.Stack(new cdk.App(), 'B');
		assert.notStrictEqual(apiFrontDoorMarkerValue(a), apiFrontDoorMarkerValue(b));
	});

	test('a literal webAclArn must match the scope and region it attaches to', () => {
		const cases: Array<[boolean, string, string, RegExp]> = [
			[false, 'us-east-1', 'arn:aws:wafv2:us-east-1:111122223333:global/webacl/x/1', /REGIONAL web ACL in this stack's region/],
			[false, 'us-east-1', 'arn:aws:wafv2:eu-west-1:111122223333:regional/webacl/x/1', /REGIONAL web ACL in this stack's region/],
			[true, 'eu-west-1', 'arn:aws:wafv2:eu-west-1:111122223333:regional/webacl/x/1', /CLOUDFRONT-scoped web ACL in us-east-1/],
			[true, 'eu-west-1', 'arn:aws:wafv2:eu-west-1:111122223333:global/webacl/x/1', /CLOUDFRONT-scoped web ACL in us-east-1/],
			[false, 'us-east-1', 'not-an-arn', /must be a WAFv2 web ACL ARN/],
		];
		for (const [provision, region, webAclArn, error] of cases) {
			const { stack, stage } = owner({ webAclArn }, region);
			scheduleApiFrontDoor(stack, provision, GATEWAY_URL, stage);
			assert.throws(() => Template.fromStack(stack), error, webAclArn);
		}
	});

	test('a token webAclArn is not checked at synth', () => {
		const { stack, stage } = owner(undefined);
		const param = new cdk.CfnParameter(stack, 'AclArn');
		stack._apiWaf = { webAclArn: param.valueAsString };
		scheduleApiFrontDoor(stack, false, GATEWAY_URL, stage);
		Template.fromStack(stack).resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
	});
});
