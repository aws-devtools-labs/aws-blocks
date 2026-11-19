// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard name and console URL derivation, shared by every layer.
 *
 * The CDK layer provisions the CloudWatch Dashboard under {@link deriveDashboardName}
 * and outputs {@link dashboardConsoleUrl}; the AWS runtime and the mock derive the
 * same name from the same inputs (the explicit `dashboardName` option, else the
 * block's `fullId`), so each instance knows its own dashboard without the CDK
 * layer handing a URL to the runtime. Free of `aws-cdk-lib` imports so the runtime
 * entry can use it.
 *
 * @internal
 */

/**
 * The CloudWatch Dashboard name for a block: the explicit `dashboardName` option,
 * else `fullId`, else `id`, with characters CloudWatch rejects replaced by `-` and
 * cut to CloudWatch's 255-character limit.
 *
 * @param id - The block's construct id (last fallback).
 * @param dashboardName - The `dashboardName` option, if the caller set one.
 * @param fullId - The block's scope-qualified id (the default name).
 * @returns The sanitized dashboard name.
 *
 * @internal
 */
export function deriveDashboardName(id: string, dashboardName?: string, fullId?: string): string {
	return (dashboardName ?? fullId ?? id).replace(/[^A-Za-z0-9\-_]/g, '-').substring(0, 255);
}

/**
 * The CloudWatch console URL of the dashboard `dashboardName` in `region`.
 *
 * The CDK layer passes the `AWS::Region` token; the AWS runtime passes the
 * compute's `AWS_REGION`, which is the region of the stack that deployed it.
 *
 * @param region - AWS region (a literal or a CDK token).
 * @param dashboardName - The dashboard name from {@link deriveDashboardName}.
 * @returns The console URL.
 *
 * @internal
 */
export function dashboardConsoleUrl(region: string, dashboardName: string): string {
	return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#dashboards/dashboard/${dashboardName}`;
}
