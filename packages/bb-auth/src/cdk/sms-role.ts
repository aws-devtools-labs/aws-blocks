// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The trust of the SMS role CDK's `UserPool` creates — CDK side.
 *
 * CDK adds that role (`pool/smsRole`) on its own when the pool sends SMS: phone
 * sign-in / verification, or SMS MFA. `Auth` sets no `smsRole` prop, so the
 * role is CDK's default, rendered with one `cognito-idp` trust statement whose
 * only condition is the `sts:ExternalId` SMS needs; CDK offers no prop to
 * extend it. The role lives under the `Auth` scope, which marks itself as AWS
 * Blocks-owned (its `bbName` is an official Building Block's), so the core
 * synth-time trust check holds it to the source-condition rule.
 *
 * @internal
 */

import { sourceScopedConditions } from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import type * as cognito from 'aws-cdk-lib/aws-cognito';

/**
 * Limit the trust of the SMS role CDK's `UserPool` creates to Cognito user
 * pools in this account and region: `aws:SourceAccount` (the stack account) and
 * `aws:SourceArn` matching `arn:<partition>:cognito-idp:<region>:<account>:userpool/*`,
 * as the Cognito SMS settings documentation recommends. The two keys are merged
 * into the statement's existing condition by property override; the external
 * id is kept. The wildcard names no concrete pool, so the role does not depend
 * on the pool that uses it. No-op when CDK created no SMS role.
 */
export function scopeSmsRoleTrust(pool: cognito.UserPool): void {
	const cfnRole = pool.node.tryFindChild('smsRole')?.node.defaultChild;
	if (!cfnRole || !cdk.CfnResource.isCfnResource(cfnRole)) return;
	const conditions = sourceScopedConditions(cdk.Stack.of(pool), 'cognito-idp', 'userpool/*');
	const path = 'AssumeRolePolicyDocument.Statement.0.Condition';
	cfnRole.addPropertyOverride(`${path}.StringEquals.aws:SourceAccount`, conditions.StringEquals['aws:SourceAccount']);
	cfnRole.addPropertyOverride(`${path}.ArnLike.aws:SourceArn`, conditions.ArnLike['aws:SourceArn']);
}
