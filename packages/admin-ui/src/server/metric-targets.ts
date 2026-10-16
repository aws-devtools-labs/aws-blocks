// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RawStackResource } from './log-groups.js';
import type { RawTemplate } from './resources.js';

/**
 * Metric target discovery (usage view): which CloudWatch metrics describe THIS
 * stage's deployment, derived from the stack's own resources — the same source
 * of truth log group discovery uses, so no naming conventions and no guessing.
 *
 * A target is a namespace plus the exact dimension set that selects one
 * resource. Getting a dimension wrong does not error: CloudWatch returns an
 * empty series, which renders as a flat zero line and reads as "nothing is
 * using the app". So every dimension here is one this module can derive from a
 * stack resource, and a resource whose dimension value is not derivable
 * produces NO target rather than a guessed one.
 *
 * THE SHARED-DIMENSION PROBLEM, which is why {@link MetricTarget} carries
 * `sharedDimensions`:
 *
 * Most AWS resources are dimensioned by a physical name that CloudFormation
 * already made unique per stack (`<stack>-rota-staff`), so sandbox and
 * production separate for free. API Gateway REST APIs are not: their metrics
 * are dimensioned by `ApiName` + `Stage`, the API's DISPLAY NAME, which CDK
 * sets from the construct and which is therefore identical in every stage of
 * the same app. Two stacks of one app both report under
 * `{ApiName: 'Blocks API', Stage: 'prod'}`, and CloudWatch sums them.
 *
 * That cannot be fixed by querying differently — the per-stage series does not
 * exist in CloudWatch to be fetched. The only honest options are to omit the
 * target or to label it, and omitting it would silently drop the single number
 * the user most wants (API invocations). So it is labelled, and the view must
 * say the figure spans every stage sharing the name rather than presenting it
 * as this environment's traffic.
 */

/** A CloudWatch dimension: a name and the value that selects one resource. */
export interface MetricDimension {
	name: string;
	value: string;
}

/** What a target measures, for grouping and labelling in the view. */
export type MetricTargetKind = 'api' | 'function' | 'table' | 'workflow' | 'topic' | 'cdn';

/** One resource's CloudWatch coordinates, plus whether they are stage-unique. */
export interface MetricTarget {
	/** CloudWatch namespace, e.g. `AWS/Lambda`. */
	namespace: string;
	/** The dimension set selecting this resource. Order is stable for cache keys. */
	dimensions: MetricDimension[];
	kind: MetricTargetKind;
	/** Display label — the resource's own short name, not the stack-prefixed one. */
	label: string;
	/** CloudFormation logical id this came from, so a target traces to a resource. */
	logicalResourceId: string;
	resourceType: string;
	/**
	 * True when this dimension set is NOT unique to one stack, so the series
	 * aggregates every stage of the app. See the shared-dimension note above.
	 */
	sharedDimensions?: true;
	/** Why the dimensions are shared, for the view to show verbatim. */
	sharedReason?: string;
}

/**
 * CloudWatch's `AWS/ApiGateway` namespace serves both REST (v1) and HTTP/
 * WebSocket (v2) APIs, with DIFFERENT dimensions: v1 by `ApiName`, v2 by
 * `ApiId`. The v2 form is stage-unique because an API id is; the v1 form is
 * not.
 */
const API_GATEWAY_NAMESPACE = 'AWS/ApiGateway';

const SHARED_API_NAME_REASON =
	'API Gateway REST metrics are dimensioned by the API display name, which is the same in every stage of this app, so this series sums all of them.';

/** Resource types that are metric targets, with the kind they map to. */
const TARGET_KINDS: Record<string, MetricTargetKind> = {
	'AWS::ApiGateway::RestApi': 'api',
	'AWS::ApiGatewayV2::Api': 'api',
	'AWS::Lambda::Function': 'function',
	'AWS::DynamoDB::Table': 'table',
	'AWS::StepFunctions::StateMachine': 'workflow',
	'AWS::SNS::Topic': 'topic',
	'AWS::CloudFront::Distribution': 'cdn',
};

/**
 * Strips the stack-name prefix from a physical resource name, so the view shows
 * `rota-staff` rather than `rota-3a4f18-dev-bf9209-rota-staff`. The prefix
 * is removed only when it is actually there, so a resource with an explicitly
 * set name is left alone.
 */
export function shortLabel(physicalResourceId: string, stackName?: string): string {
	if (stackName && physicalResourceId.startsWith(`${stackName}-`)) {
		return physicalResourceId.slice(stackName.length + 1);
	}
	return physicalResourceId;
}

/** Last colon-delimited field of an ARN, which is the resource's own name. */
function nameFromArn(arn: string): string | undefined {
	const parts = arn.split(':');
	const last = parts[parts.length - 1];
	return parts.length > 1 && last.length > 0 ? last : undefined;
}

/**
 * Inputs a target needs beyond the stack resource itself.
 *
 * `apiNames` maps a REST API's id to its display NAME, because the name is the
 * metric dimension and CloudFormation's resource list reports only the id. It
 * is passed in rather than read here so the mapping stays pure: see
 * {@link templateRestApiNames} for the function that derives it.
 */
export interface MetricTargetOptions {
	/** Deployed stack name, used to shorten labels. */
	stackName?: string;
	/** REST API id → display name. A missing entry yields no target for that API. */
	apiNames?: Map<string, string>;
	/** REST API stage name (the `AWS::ApiGateway::Stage` physical id), e.g. `prod`. */
	restApiStage?: string;
}

/**
 * Pure mapping: stack resources → CloudWatch metric targets.
 *
 * A resource contributes a target only when every dimension value is known. The
 * two deliberate omissions:
 *
 * - A REST API whose display name was not resolved. The id cannot stand in for
 *   the name, and a target with the wrong dimension renders an empty chart.
 * - Any resource with no physical id, which means it is mid-create and has no
 *   metrics yet.
 */
export function resourcesToMetricTargets(
	resources: RawStackResource[],
	options: MetricTargetOptions = {},
): MetricTarget[] {
	const { stackName, apiNames, restApiStage } = options;
	const targets: MetricTarget[] = [];

	for (const resource of resources) {
		const { ResourceType: type, PhysicalResourceId: physicalId, LogicalResourceId: logicalId } = resource;
		if (!type || !physicalId || !logicalId) continue;
		const kind = TARGET_KINDS[type];
		if (!kind) continue;

		const base = { kind, logicalResourceId: logicalId, resourceType: type };

		switch (type) {
			case 'AWS::ApiGateway::RestApi': {
				// The dimension is the DISPLAY NAME, not this physical id.
				const apiName = apiNames?.get(physicalId);
				if (!apiName) continue;
				targets.push({
					...base,
					namespace: API_GATEWAY_NAMESPACE,
					dimensions: [
						{ name: 'ApiName', value: apiName },
						...(restApiStage ? [{ name: 'Stage', value: restApiStage }] : []),
					],
					label: apiName,
					sharedDimensions: true,
					sharedReason: SHARED_API_NAME_REASON,
				});
				break;
			}
			case 'AWS::ApiGatewayV2::Api':
				// v2 is dimensioned by api id, which is unique per stack.
				targets.push({
					...base,
					namespace: API_GATEWAY_NAMESPACE,
					dimensions: [{ name: 'ApiId', value: physicalId }],
					label: physicalId,
				});
				break;
			case 'AWS::Lambda::Function':
				targets.push({
					...base,
					namespace: 'AWS/Lambda',
					dimensions: [{ name: 'FunctionName', value: physicalId }],
					label: shortLabel(physicalId, stackName),
				});
				break;
			case 'AWS::DynamoDB::Table':
				targets.push({
					...base,
					namespace: 'AWS/DynamoDB',
					dimensions: [{ name: 'TableName', value: physicalId }],
					label: shortLabel(physicalId, stackName),
				});
				break;
			case 'AWS::StepFunctions::StateMachine': {
				// Dimensioned by the full ARN, which IS the physical id here.
				const name = nameFromArn(physicalId) ?? physicalId;
				targets.push({
					...base,
					namespace: 'AWS/States',
					dimensions: [{ name: 'StateMachineArn', value: physicalId }],
					label: name,
				});
				break;
			}
			case 'AWS::SNS::Topic': {
				// Dimensioned by topic NAME, the last ARN field.
				const name = nameFromArn(physicalId);
				if (!name) continue;
				targets.push({
					...base,
					namespace: 'AWS/SNS',
					dimensions: [{ name: 'TopicName', value: name }],
					label: shortLabel(name, stackName),
				});
				break;
			}
			case 'AWS::CloudFront::Distribution':
				/*
				 * CloudFront publishes to us-east-1 ONLY, whatever region the
				 * distribution serves, and its dimensions include a required
				 * `Region: Global`. A target carrying the stack's region would
				 * query the wrong endpoint and come back empty, so the caller
				 * must read this one from us-east-1 (see `metricRegion`).
				 */
				targets.push({
					...base,
					namespace: 'AWS/CloudFront',
					dimensions: [
						{ name: 'DistributionId', value: physicalId },
						{ name: 'Region', value: 'Global' },
					],
					label: physicalId,
				});
				break;
		}
	}

	return targets.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
}

/** us-east-1 for CloudFront, the stack's own region for everything else. */
export function metricRegion(target: MetricTarget, stackRegion: string): string {
	return target.namespace === 'AWS/CloudFront' ? 'us-east-1' : stackRegion;
}

/**
 * A stable key for one target's dimension set, for caching and deduplication.
 * Dimensions are sorted by name so two equal sets in different orders agree.
 */
export function targetKey(target: MetricTarget): string {
	const dimensions = [...target.dimensions]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((d) => `${d.name}=${d.value}`)
		.join(',');
	return `${target.namespace}|${dimensions}`;
}

/** The REST API stage name from a stack's `AWS::ApiGateway::Stage` resource. */
export function findRestApiStage(resources: RawStackResource[]): string | undefined {
	return resources.find((r) => r.ResourceType === 'AWS::ApiGateway::Stage' && r.PhysicalResourceId)
		?.PhysicalResourceId;
}

/**
 * Maps REST API logical ids to their display names, read from the deployed
 * template's `Properties.Name`.
 *
 * The template rather than the API Gateway API, for three reasons: the template
 * is already fetched for resource grouping, so this costs no extra call; it
 * needs no new SDK client; and it is a pure function of data the caller already
 * holds. The physical id CloudFormation reports is NOT the metric dimension,
 * which is why the name has to come from somewhere at all.
 *
 * A `Name` that is a CloudFormation intrinsic (`Ref`, `Fn::Join`) rather than a
 * literal string is SKIPPED, because the resolved value is not in the template
 * and a serialised intrinsic as a dimension would query nothing. That api then
 * produces no target, which is the honest outcome: see the omission note on
 * {@link resourcesToMetricTargets}.
 */
export function templateRestApiNames(template: RawTemplate): Map<string, string> {
	const names = new Map<string, string>();
	for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
		if (resource.Type !== 'AWS::ApiGateway::RestApi') continue;
		const name = resource.Properties?.Name;
		if (typeof name === 'string' && name.length > 0) names.set(logicalId, name);
	}
	return names;
}

/**
 * Re-keys template names (by LOGICAL id) onto physical ids, which is what the
 * resource list and therefore {@link MetricTargetOptions.apiNames} use.
 */
export function restApiNamesByPhysicalId(resources: RawStackResource[], template: RawTemplate): Map<string, string> {
	const byLogicalId = templateRestApiNames(template);
	const byPhysicalId = new Map<string, string>();
	for (const resource of resources) {
		if (resource.ResourceType !== 'AWS::ApiGateway::RestApi') continue;
		const { LogicalResourceId: logicalId, PhysicalResourceId: physicalId } = resource;
		if (!logicalId || !physicalId) continue;
		const name = byLogicalId.get(logicalId);
		if (name) byPhysicalId.set(physicalId, name);
	}
	return byPhysicalId;
}

/**
 * Discovers this stage's metric targets from its deployed stack: a pure join of
 * the resource list and the template, both of which the caller already fetches.
 */
export function discoverMetricTargets(
	resources: RawStackResource[],
	template: RawTemplate,
	stackName?: string,
): MetricTarget[] {
	const apiNames = restApiNamesByPhysicalId(resources, template);
	const restApiStage = findRestApiStage(resources);
	return resourcesToMetricTargets(resources, {
		...(stackName ? { stackName } : {}),
		...(apiNames.size > 0 ? { apiNames } : {}),
		...(restApiStage ? { restApiStage } : {}),
	});
}
