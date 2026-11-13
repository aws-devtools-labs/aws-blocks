// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS console deep links for the resources of a CloudFormation stack.
 *
 * WHY ONLY FIFTEEN TYPES ARE MAPPED
 *
 * A confident-looking link to nothing is worse than no link at all: the user
 * clicks, lands on an error page or an empty list, and now distrusts every
 * other link on the page. So this module maps ONLY resource types that have a
 * genuinely useful console page, and everything else falls back to the stack's
 * own Resources tab with `direct: false` — a page that is always correct, even
 * if it is one click away from the resource. When not even a stack name is
 * available there is nothing honest to return, so the answer is `undefined`
 * rather than a guessed URL.
 *
 * The console's routes are also not a contract. They change without notice,
 * which is the second reason the fallback has to exist: when a route rots, the
 * blast radius is one entry in the map, and the fallback still works.
 */

/** A console URL, plus whether it opens the resource itself or only its stack. */
export interface ConsoleLink {
	/** Absolute console URL. Never contains the substring `undefined`. */
	url: string;
	/** True when the URL opens the resource; false for the stack Resources tab fallback. */
	direct: boolean;
}

/** Builds one resource URL from its physical id and the stack's region. */
type LinkBuilder = (physicalResourceId: string, region: string) => string;

const CONSOLE_HOST = 'console.aws.amazon.com';

/**
 * CloudFront and IAM are global services. A region qualifier on those URLs is
 * not merely redundant, it is actively misleading — it implies a regional
 * resource where none exists — so the global base carries no region at all.
 */
const GLOBAL_BASE = `https://${CONSOLE_HOST}`;

/** Regional console base, e.g. `https://us-east-1.console.aws.amazon.com`. */
function regionalBase(region: string): string {
	return `https://${region}.${CONSOLE_HOST}`;
}

/** Coerces a possibly-absent value to a string, so no URL can ever interpolate `undefined`. */
function asText(value: string | undefined): string {
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * Encodes a log group name for the CloudWatch console's `logsV2` route, which
 * wants each slash DOUBLE-encoded: one `encodeURIComponent` pass, then every
 * resulting `%2F` rewritten to `$252F`. `/aws/lambda/my-fn` must therefore
 * appear as `$252Faws$252Flambda$252Fmy-fn`.
 *
 * DO NOT "SIMPLIFY" THIS TO A SINGLE ROUND OF ENCODING. The fragment is parsed
 * twice by the console — once as a URL fragment, then again by its own router,
 * where `$25` is how a literal `%` survives — so a single pass yields
 * `%2Faws%2F...`, which the router reads as real path separators and resolves
 * to a log group that does not exist. The link looks fine and goes nowhere,
 * the exact failure mode this module exists to avoid.
 */
function encodeLogGroupName(name: string): string {
	// split/join, not String.replace: `$` is a replacement-pattern sigil there,
	// so a `'$252F'` replacement string is one typo away from a group reference.
	return encodeURIComponent(name).split('%2F').join('$252F');
}

/**
 * The type → console URL map. Keyed by CloudFormation resource type; the value
 * builds the URL from the resource's PHYSICAL id (not its logical id).
 */
const LINK_BUILDERS: Record<string, LinkBuilder> = {
	'AWS::DynamoDB::Table': (id, region) => `${regionalBase(region)}/dynamodbv2/home?region=${region}#table?name=${id}`,
	'AWS::Lambda::Function': (id, region) => `${regionalBase(region)}/lambda/home?region=${region}#/functions/${id}`,
	'AWS::Cognito::UserPool': (id, region) =>
		`${regionalBase(region)}/cognito/v2/idp/user-pools/${id}/users?region=${region}`,
	'AWS::S3::Bucket': (id, region) => `${regionalBase(region)}/s3/buckets/${id}?region=${region}`,
	// Global service: no region in the host and none in the query.
	'AWS::CloudFront::Distribution': (id) => `${GLOBAL_BASE}/cloudfront/v4/home#/distributions/${id}`,
	'AWS::ApiGateway::RestApi': (id, region) =>
		`${regionalBase(region)}/apigateway/main/apis/${id}/resources?region=${region}`,
	'AWS::ApiGatewayV2::Api': (id, region) =>
		`${regionalBase(region)}/apigateway/main/api-detail?region=${region}&api=${id}`,
	// A queue's physical id is its queue URL, so it has to be URI-encoded to
	// survive as one fragment path segment.
	'AWS::SQS::Queue': (id, region) =>
		`${regionalBase(region)}/sqs/v3/home?region=${region}#/queues/${encodeURIComponent(id)}`,
	'AWS::SNS::Topic': (id, region) => `${regionalBase(region)}/sns/v3/home?region=${region}#/topic/${id}`,
	'AWS::Logs::LogGroup': (id, region) =>
		`${regionalBase(region)}/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${encodeLogGroupName(id)}`,
	'AWS::StepFunctions::StateMachine': (id, region) =>
		`${regionalBase(region)}/states/home?region=${region}#/statemachines/view/${id}`,
	'AWS::Events::Rule': (id, region) =>
		`${regionalBase(region)}/events/home?region=${region}#/eventbus/default/rules/${id}`,
	'AWS::SecretsManager::Secret': (id, region) =>
		`${regionalBase(region)}/secretsmanager/secret?name=${id}&region=${region}`,
	// Parameter names are hierarchical and usually start with `/`. Interpolating
	// one raw would produce an empty path segment (`/parameters//app/db/...`),
	// so the name is URI-encoded — a no-op for a flat name like `my-param`.
	'AWS::SSM::Parameter': (id, region) =>
		`${regionalBase(region)}/systems-manager/parameters/${encodeURIComponent(id)}/description?region=${region}`,
	// Global service: no region in the host and none in the query.
	'AWS::IAM::Role': (id) => `${GLOBAL_BASE}/iam/home#/roles/${id}`,
};

/** Inserts a space at each lower/digit → upper boundary: `LogGroup` → `Log Group`. */
function splitWords(segment: string): string {
	return segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/**
 * Splits a trailing version suffix off a service name: `ApiGatewayV2` →
 * `ApiGateway V2`. Only the suffix is split, because service names are brand
 * names whose internal capitalisation is meaningful — a general camel-case
 * split would mangle `DynamoDB` into `Dynamo DB`.
 */
function splitVersionSuffix(segment: string): string {
	return segment.replace(/([a-z])(V\d+)$/, '$1 $2');
}

/**
 * A human label for a CloudFormation resource type, derived from the type
 * string rather than a second lookup table that could drift out of step with
 * the map above. `AWS::DynamoDB::Table` → `DynamoDB Table`.
 */
export function friendlyType(resourceType: string): string {
	const segments = asText(resourceType)
		.split('::')
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);
	if (segments.length === 0) {
		return '';
	}
	// Drop the vendor namespace (`AWS`, `Custom`, a third-party prefix) when present.
	const named = segments.length > 1 ? segments.slice(1) : segments;
	const [service, ...rest] = named;
	return [splitVersionSuffix(service ?? ''), ...rest.map(splitWords)].join(' ');
}

/** The stack's Resources tab — the fallback that is correct for every resource type. */
export function stackResourcesUrl(stackName: string, region: string): string {
	const name = encodeURIComponent(asText(stackName));
	return `${regionalBase(region)}/cloudformation/home?region=${region}#/stacks/resources?stackName=${name}`;
}

/**
 * Best available console link for one stack resource.
 *
 * - A mapped type with a physical id → direct resource link (`direct: true`).
 * - A mapped type with no physical id yet (mid-create) or an unmapped type →
 *   the stack's Resources tab (`direct: false`).
 * - Nothing usable, i.e. no stack name to fall back to → `undefined`.
 *
 * Never throws, and never returns a URL containing `undefined`.
 */
export function consoleLink(
	resourceType: string,
	physicalResourceId: string | undefined,
	stackName: string | undefined,
	region: string,
): ConsoleLink | undefined {
	const id = asText(physicalResourceId);
	const build = LINK_BUILDERS[asText(resourceType)];
	if (build && id.length > 0) {
		return { url: build(id, asText(region)), direct: true };
	}
	const stack = asText(stackName);
	if (stack.length === 0) {
		return undefined;
	}
	return { url: stackResourcesUrl(stack, asText(region)), direct: false };
}
