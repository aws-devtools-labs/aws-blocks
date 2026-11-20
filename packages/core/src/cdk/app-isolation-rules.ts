// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The app-isolation rules behind `defaults.appIdentity`: pure functions over
 * CloudFormation-resolved JSON (no `aws-cdk-lib`), which the synth-time IAM
 * report applies to the roles, policies and resource policies CDK Blocks
 * renders for the app's templates (its `violations` list, and the synth failure).
 *
 * Every rule answers "does this reach outside the app?". An app's resources are
 * the ones whose name starts with the app's prefix: `<id>` followed by `-`, `/`
 * or the end of the name (`appa`, `appa-notes`, `/appa/key`). The id can't
 * contain `-`, so `appa-*` never matches another app (`appab-…`). Two namespaces
 * CDK Blocks and CDK pick count the same way: a cross-region reference's SSM
 * parameter (`/cdk/exports/<consumer stack>/…`, checked by the stack name), and
 * Hosting's `secret()` / `config()` values (`blocks/<stackId>/…`, the app's own
 * only when `stackId` is the app id).
 *
 * These checks are fast feedback, not the boundary: the app's own code runs at
 * synth, so a determined app could get around them. The boundary is IAM (the
 * platform's permissions boundary, per-app execution role and deploy guard; see
 * `SHARED-ACCOUNT.md`, linked from the core README's "Running many apps in one
 * AWS account").
 *
 * @internal
 */

/** The tag key CDK Blocks stamps with the app id (mirrors `BLOCKS_APP_TAG_KEY`). */
export const APP_TAG_KEY = 'app';

/**
 * `defaults.appIdentity.id`: lowercase letters and digits, starting with a letter, 1–10
 * characters. Ten is CDK's limit for a bootstrap qualifier, so the app id can be
 * the app's qualifier as-is: one bootstrap per app, and no two apps can end up
 * sharing one through truncation.
 */
export const APP_ID_PATTERN = /^[a-z][a-z0-9]{0,9}$/;

/**
 * App ids that match {@link APP_ID_PATTERN} but can't be used, with why. The
 * platform's policies give an app every name `<id>`, `<id>-…` or `<id>/…` (in
 * the boundary, `${aws:PrincipalTag/app}`, `${APP}-*`, `${APP}/*`; in the
 * execution policy and deploy guard, the same patterns with the id spelled
 * out). These ids turn such a pattern into a namespace other apps, CDK Blocks,
 * CDK or AWS share, so they would give the app access to resources it doesn't
 * own. Matching is case-sensitive and ids are lowercase, so only lowercase names
 * count (`CDKToolkit-…` stacks are safe).
 */
export const RESERVED_APP_IDS: Readonly<Record<string, string>> = {
	// `${APP}-*` / `${APP}/*` would match every app's CDK bootstrap: the asset
	// buckets `cdk-<qualifier>-assets-…`, the roles `cdk-<qualifier>-…-role-…`, the
	// parameters `/cdk-bootstrap/<qualifier>/…`, and CDK's own `/cdk/exports/…` and
	// `/cdk/EdgeFunctionArn/…` parameters.
	cdk: "CDK's namespace: every app's bootstrap (`cdk-<qualifier>-…` buckets and roles, `/cdk-bootstrap/…`) and CDK's `/cdk/…` parameters",
	// `/blocks/${APP}/*` and `blocks/${APP}/*` are Hosting's per-app values; `${APP}/*`
	// with `blocks` would match all of them.
	blocks: "AWS CDK Blocks' namespace: every app's Hosting `secret()` / `config()` values (`blocks/<id>/…`)",
	// Hosting's values without a `stackId` live under `/blocks/secrets/…` and
	// `/blocks/config/…`, which `blocks/${APP}/*` would match for these ids.
	secrets: "Hosting's shared `secret()` namespace for apps without a `stackId` (`blocks/secrets/…`)",
	config:
		"Hosting's shared `config()` namespace for apps without a `stackId` (`/blocks/config/…`), and AWS Config's default bucket (`config-bucket-<account>`)",
	// AWS Amplify names its stacks and the resources in them `amplify-<app>-<branch>-…`.
	amplify: "AWS Amplify's namespace (`amplify-…` stacks, roles, functions and buckets)",
	// The CloudFormation console uploads templates to `cf-templates-<hash>-<region>`.
	cf: "the CloudFormation console's template buckets (`cf-templates-…`)",
	// The SageMaker SDK's default bucket is `sagemaker-<region>-<account>`.
	sagemaker: "SageMaker's default buckets (`sagemaker-<region>-<account>`)",
	// CDK names a CloudFront Function `<region><construct id>` (`us-east-1MyStack…`)
	// when no name is given: `function/${id}-*` would match every such function in
	// the region group's regions, including an app's own from before it set `defaults.appIdentity`.
	af: 'a region prefix: CDK names CloudFront Functions `<region>…` (`af-south-1…`)',
	ap: 'a region prefix: CDK names CloudFront Functions `<region>…` (`ap-southeast-2…`)',
	ca: 'a region prefix: CDK names CloudFront Functions `<region>…` (`ca-central-1…`)',
	cn: 'a region prefix: CDK names CloudFront Functions `<region>…` (`cn-north-1…`)',
	eu: 'a region prefix: CDK names CloudFront Functions `<region>…` (`eu-west-1…`)',
	eusc: 'a region prefix: CDK names CloudFront Functions `<region>…` (`eusc-de-east-1…`)',
	il: 'a region prefix: CDK names CloudFront Functions `<region>…` (`il-central-1…`)',
	me: 'a region prefix: CDK names CloudFront Functions `<region>…` (`me-south-1…`)',
	mx: 'a region prefix: CDK names CloudFront Functions `<region>…` (`mx-central-1…`)',
	sa: 'a region prefix: CDK names CloudFront Functions `<region>…` (`sa-east-1…`)',
	us: 'a region prefix: CDK names CloudFront Functions `<region>…` (`us-east-1…`)',
};

/**
 * Prefixes no app id may start with, with why. A prefix rather than an exact id,
 * because AWS reserves the prefix itself.
 */
export const RESERVED_APP_ID_PREFIXES: Readonly<Record<string, string>> = {
	// `aws-*` and `aws/*` names belong to AWS and its services: `aws-cloudtrail-logs-…`,
	// `aws-athena-query-results-…` and `aws-sam-cli-managed-…` buckets and stacks,
	// `aws-controltower-…` functions, roles, topics, rules and log groups, the
	// `aws-reserved/…` and `aws-service-role/…` role paths, the public
	// `/aws/service/…` parameters, and Elastic Beanstalk's `awseb-…` stacks.
	aws: 'AWS reserves names starting with "aws" (`aws-…` buckets, stacks and roles, `/aws/…` parameters, `awseb-…` stacks)',
	// SSM rejects parameter names that start with `aws` or `ssm` (case-insensitive),
	// so the app couldn't create its own parameters.
	ssm: 'Systems Manager rejects parameter names that start with "ssm", so the app couldn\'t create its own parameters',
};

/**
 * Why `id` can't be an app id, or `undefined` when it can: the one check every
 * place that takes an app id uses (`defaults.appIdentity.id`, through
 * `resolveAppIdentity`, which fails synth with this message).
 */
export function appIdProblem(id: unknown): string | undefined {
	if (typeof id !== 'string' || !APP_ID_PATTERN.test(id)) {
		return (
			`${JSON.stringify(id)} isn't an app id. An app id is 1–10 lowercase letters and digits, starting with a ` +
			'letter (e.g. "orders" or "app42"). No hyphens: the id is the name prefix ("<id>-…") that keeps one app ' +
			"away from another app's resources. At most 10 characters: the id is also the app's CDK bootstrap " +
			'qualifier, which CDK limits to 10.'
		);
	}
	const reserved = Object.hasOwn(RESERVED_APP_IDS, id) ? RESERVED_APP_IDS[id] : undefined;
	if (reserved) {
		return `"${id}" is reserved: the app's "${id}-…" / "${id}/…" names would include ${reserved}. Choose another id.`;
	}
	for (const [prefix, why] of Object.entries(RESERVED_APP_ID_PREFIXES)) {
		if (id.startsWith(prefix)) return `"${id}" starts with the reserved prefix "${prefix}": ${why}. Choose another id.`;
	}
	return undefined;
}

/** What a violation is about. */
export type AppViolationRule =
	| 'no-permissions-boundary'
	| 'role-without-boundary'
	| 'role-tag-mismatch'
	| 'role-trust-not-service'
	| 'stack-name-outside-app'
	| 'scope-outside-app'
	| 'grant-outside-app'
	| 'inverse-grant'
	| 'unresolvable-grant'
	| 'wildcard-data-grant'
	| 'broad-managed-policy'
	| 'resource-policy-outside-app'
	| 'api-outside-app';

/** One finding. `path` is the construct path of what the finding is about. */
export interface AppViolation {
	rule: AppViolationRule;
	message: string;
	path?: string;
}

/**
 * Whether `name` belongs to app `id` (see the module doc), for a resource of
 * `service`. Every service's names start with `<id>-`; only SSM parameters may
 * also be `<id>` or `<id>/…`, as in the boundary (`OwnParameters`). A table,
 * queue, bucket or function named `<id>` or `<id>/…` is outside the app: the
 * boundary allows only `<id>-*` there, so the grant would be denied at runtime.
 */
export function isUnderAppPrefix(name: string, id: string, service?: string): boolean {
	const n = name.startsWith('/') ? name.slice(1) : name;
	if (n.startsWith(`${id}-`)) return true;
	return service === 'ssm' && (n === id || n.startsWith(`${id}/`));
}

/**
 * Services an app can reach another app's data or code through. A grant on one
 * of these outside the app's prefix, or on `*`, is a violation.
 */
const DATA_SERVICES = new Set([
	'ssm',
	'dynamodb',
	'sqs',
	's3',
	'secretsmanager',
	'lambda',
	'logs',
	'states',
	'cognito-idp',
	'events',
	'scheduler',
	'kms',
	'execute-api',
	'apigateway',
	'sns',
	'ses',
	'rds',
	'rds-data',
	'dsql',
	'bedrock',
	'bedrock-agentcore',
	's3vectors',
	'ecs',
	'cloudfront-keyvaluestore',
	// Not data, but a way into another app's: passing or assuming another app's role.
	'iam',
	'sts',
]);

/**
 * Data services whose resource names the check doesn't read: named by id (DSQL
 * clusters, knowledge bases, AgentCore runtimes, KeyValueStores), matched by
 * tag rather than name in the boundary (SNS topics, SES identities), or named by
 * CloudFormation without a `-` after the app id (ECS task-definition families).
 * RDS clusters and instances, the RDS Data API and S3 Vectors buckets are named
 * `<id>-…` and read by name ({@link arnResourceName}). For
 * these, only a wildcard counts: `*`, or a resource whose name after its type
 * (`cluster/`, `cluster:`, `knowledge-base/`, `bucket/`, `identity/`, …) starts
 * with `*`.
 */
const WILDCARD_ONLY_SERVICES = new Set([
	'sns',
	'ses',
	'dsql',
	'bedrock',
	'bedrock-agentcore',
	'ecs',
	'cloudfront-keyvaluestore',
]);

/** Placeholder for a reference to one of the template's own resources inside a rendered ARN. */
const TOKEN = '\u0000';

/** What a resolved `Resource` value names. */
export type RenderedResource =
	/** A reference to a resource in the same template (`Ref` to a resource, `Fn::GetAtt`): the app's own. */
	| { kind: 'own' }
	/** A string ARN; references to own resources inside it are {@link TOKEN}, pseudo parameters `*`. */
	| { kind: 'arn'; arn: string }
	/** A value the check can't see through (`Fn::Sub`, `Fn::ImportValue`, `Ref` to a template parameter, …). */
	| { kind: 'unresolvable' };

/** Intrinsics whose result is one of the template's own resources. */
const OWN_INTRINSICS = new Set(['Fn::GetAtt']);

/**
 * Render a resolved `Resource` value (see {@link RenderedResource}). `parameters`
 * are the template's parameter names: a `Ref` to one is a value the deployer
 * supplies, so it's unresolvable, not "own".
 */
export function renderResource(value: unknown, parameters: ReadonlySet<string> = new Set()): RenderedResource {
	if (typeof value === 'string') return { kind: 'arn', arn: value };
	if (!value || typeof value !== 'object') return { kind: 'unresolvable' };
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj);
	if (typeof obj.Ref === 'string') {
		if (obj.Ref.startsWith('AWS::')) return { kind: 'arn', arn: '*' };
		return parameters.has(obj.Ref) ? { kind: 'unresolvable' } : { kind: 'own' };
	}
	if (keys.length === 1 && OWN_INTRINSICS.has(keys[0])) return { kind: 'own' };
	// `Fn::Sub` with only pseudo parameters (e.g. CDK's asset bucket name) or
	// references to the template's own resources is a readable name.
	const sub = obj['Fn::Sub'];
	if (typeof sub === 'string') {
		let unresolvable = false;
		const arn = sub.replace(/\$\{([^}]+)\}/g, (_m, ref: string) => {
			if (ref.startsWith('AWS::')) return '*';
			if (parameters.has(ref.split('.')[0])) unresolvable = true;
			return TOKEN;
		});
		return unresolvable ? { kind: 'unresolvable' } : { kind: 'arn', arn };
	}
	const join = obj['Fn::Join'];
	if (Array.isArray(join) && typeof join[0] === 'string' && Array.isArray(join[1])) {
		const parts: string[] = [];
		for (const part of join[1] as unknown[]) {
			const rendered = renderResource(part, parameters);
			if (rendered.kind === 'unresolvable') return rendered;
			parts.push(rendered.kind === 'own' ? TOKEN : rendered.arn);
		}
		return { kind: 'arn', arn: parts.join(join[0]) };
	}
	return { kind: 'unresolvable' };
}

/** `*` when an ARN's resource part is a wildcard (`*`, or `<type>/*`, `<type>:*`), else `undefined`. */
const wildcardName = (rest: string): '*' | undefined => (/^(?:[a-z][a-z-]*[/:])?\*/.test(rest) ? '*' : undefined);

/** The service and the resource-name part of an ARN, or `undefined` for a non-ARN / unsupported service. */
function arnResourceName(arn: string): { service: string; name: string } | undefined {
	if (arn === '*') return { service: '*', name: '*' };
	const m = /^arn:[^:]*:([^:]+):[^:]*:[^:]*:(.*)$/.exec(arn);
	if (!m) return undefined;
	const service = m[1];
	const rest = m[2];
	const after = (prefix: string, sep: string) =>
		rest.startsWith(prefix) ? rest.slice(prefix.length).split(sep)[0] : undefined;
	let name: string | undefined;
	switch (service) {
		case 'ssm':
			// A cross-region reference's parameter (`/cdk/exports/<consumer stack>/…`) is
			// named after the stack that reads it, so it's checked by that stack's name.
			name = rest.startsWith('parameter') ? rest.slice('parameter'.length).replace(/^\/cdk\/exports\//, '/') : undefined;
			break;
		case 'dynamodb':
			name = after('table/', '/');
			break;
		case 'sqs':
			name = rest;
			break;
		case 's3':
			name = rest.split('/')[0];
			break;
		case 'secretsmanager':
			name = after('secret:', '\u0001');
			break;
		case 'lambda':
			// A function (`function:<name>[:qualifier]`) or a layer (`layer:<name>[:version]`).
			name = after('function:', ':') ?? after('layer:', ':') ?? wildcardName(rest);
			break;
		case 'rds':
			// A cluster or an instance (`cluster:<name>`, `db:<name>`), as the boundary fences
			// them; the Data API names the cluster too. Other RDS resources: only a wildcard.
			name =
				after('cluster:', ':') ??
				after('db:', ':') ??
				wildcardName(rest);
			break;
		case 's3vectors':
			// A vector bucket, or an index in one (`bucket/<name>[/index/<index>]`).
			name = after('bucket/', '/') ?? wildcardName(rest);
			break;
		case 'logs':
			name = after('log-group:', ':')?.replace(/^\/aws\/lambda\//, '');
			break;
		case 'states':
			name = after('stateMachine:', ':') ?? after('execution:', ':');
			break;
		case 'events':
			name = after('rule/', '/') ?? after('event-bus/', '/');
			break;
		case 'scheduler':
			name = rest.startsWith('schedule/') ? rest.split('/')[2] : undefined;
			break;
		case 'apigateway': {
			// `/restapis/<api id>/…` or `/apis/<api id>/…`: like execute-api, an API id is
			// never a name under the app's prefix. Other paths (`/account`, …) aren't per-app.
			const m = /^\/(restapis|apis)\/([^/]+)/.exec(rest);
			name = m ? m[2] : undefined;
			break;
		}
		case 'cloudfront':
			// Only KeyValueStores hold data (`key-value-store/<id>`, named by id): a wildcard is checked.
			name = /^key-value-store\/\*/.test(rest) ? '*' : undefined;
			break;
		case 'iam':
			// A role (`role/<path>/<name>`) is named after the stack that creates it, so its name
			// is checked. Other IAM resources aren't an app's: only a wildcard is checked.
			name = rest.startsWith('role/')
				? rest.slice('role/'.length).split('/').pop()
				: /^[a-z-]+\/\*/.test(rest)
					? '*'
					: undefined;
			break;
		case 'execute-api':
			// `<api id>/<stage>/<method>/<path>`: an API id is never a name under the app's
			// prefix, so a literal one is always outside the app — reference the API instead.
			name = rest.split('/')[0];
			break;
		default:
			// cognito-idp and kms name resources by id, not by name: only `*` is checked.
			// The services in WILDCARD_ONLY_SERVICES are checked for a wildcard name too.
			name = WILDCARD_ONLY_SERVICES.has(service) ? wildcardName(rest) : undefined;
	}
	return name === undefined ? undefined : { service, name };
}

/** Statement as found in a resolved policy document. */
export interface ResolvedStatement {
	Sid?: string;
	Effect?: string;
	Action?: string | string[];
	NotAction?: string | string[];
	Resource?: unknown;
	NotResource?: unknown;
	Condition?: unknown;
	Principal?: unknown;
}

const asList = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Action prefixes whose resources live under another service's ARNs. */
const ARN_SERVICE_OF: Readonly<Record<string, string>> = {
	// The Data API runs statements on an RDS cluster (`arn:aws:rds:…:cluster:<name>`).
	'rds-data': 'rds',
	// KeyValueStore data-plane actions name the store's CloudFront ARN (`arn:aws:cloudfront::…:key-value-store/<id>`).
	'cloudfront-keyvaluestore': 'cloudfront',
	// `sts:AssumeRole` names the role it assumes (`arn:aws:iam::…:role/<name>`).
	sts: 'iam',
};

/** The services of `actions`, plus the ARN services their resources live under ({@link ARN_SERVICE_OF}). */
function servicesOf(actions: string[]): Set<string> {
	const out = new Set<string>();
	for (const a of actions) {
		const service = a === '*' ? '*' : a.split(':')[0].toLowerCase();
		out.add(service);
		if (Object.hasOwn(ARN_SERVICE_OF, service)) out.add(ARN_SERVICE_OF[service]);
	}
	return out;
}

function touchesData(actions: string[]): boolean {
	return actions.some((a) => a === '*' || DATA_SERVICES.has(a.split(':')[0].toLowerCase()));
}

/** Services whose own resources are fenced, so KMS through them stays inside the app. */
const VIA_SERVICE = /^(ssm|secretsmanager|dynamodb|s3|sqs)\.([a-z0-9-]+|\*)\.amazonaws\.com$/;

/**
 * Whether a `Condition` scopes a wildcard to this app's resources. Exactly two
 * shapes count, and nothing else does (an "everything except this app"
 * condition, or one naming another app, is not a scope):
 * - `StringEquals` on `aws:ResourceTag/app` equal to the app id (or the
 *   `${aws:PrincipalTag/app}` policy variable);
 * - for KMS actions only, `StringEquals`/`StringLike` on `kms:ViaService` naming
 *   only services whose own resources are fenced.
 */
function scopesWildcard(condition: unknown, actions: string[], id: string): boolean {
	if (!condition || typeof condition !== 'object') return false;
	const c = condition as Record<string, Record<string, unknown>>;
	const values = (v: unknown) => (Array.isArray(v) ? v : [v]);
	// biome-ignore lint/suspicious/noTemplateCurlyInString: an IAM policy variable, resolved by IAM at request time
	const ownTag = new Set([id, '${aws:PrincipalTag/app}']);
	const tag = c.StringEquals?.['aws:ResourceTag/app'];
	if (tag !== undefined && values(tag).every((v) => typeof v === 'string' && ownTag.has(v))) return true;
	if (actions.every((a) => a.toLowerCase().startsWith('kms:'))) {
		const via = c.StringEquals?.['kms:ViaService'] ?? c.StringLike?.['kms:ViaService'];
		// A region in the value is a pseudo parameter (`ssm.${AWS::Region}.amazonaws.com`): render it to `*`.
		const rendered = (v: unknown) => {
			const r = renderResource(v);
			return r.kind === 'arn' ? r.arn : undefined;
		};
		if (via !== undefined && values(via).every((v) => VIA_SERVICE.test(rendered(v) ?? ''))) return true;
	}
	return false;
}

/**
 * Grants CDK Blocks or CDK make that name resources outside the app's prefix,
 * but that the generated boundary still caps to the app (or that only touch
 * metadata). Each is listed with its reason; nothing else is exempt.
 *
 * @param arn the rendered ARN the grant names (`*` for a bare wildcard).
 */
function isKnownExemption(actions: string[], name: string, arn = ''): boolean {
	const only = (allowed: string[]) => actions.every((a) => allowed.includes(a));
	// CDK's cross-region export writer (`Custom::CrossRegionExportWriter`, added for
	// Hosting's us-east-1 support stack) grants these on `/cdk/exports/*` — every
	// consumer stack's exports. CDK-internal; the boundary caps it to the exports of
	// the app's own stacks (`/cdk/exports/<id>`, `<id>-…`, `<id>/…`).
	if (
		/:ssm:[^:]*:[^:]*:parameter\/cdk\/exports\/\*$/.test(arn) &&
		only(['ssm:DeleteParameters', 'ssm:ListTagsForResource', 'ssm:GetParameters', 'ssm:PutParameter'])
	) {
		return true;
	}
	// CDK's Lambda@Edge ARN reader (`Custom::CrossRegionStringParameterReader`) reads
	// `/cdk/EdgeFunctionArn/*`: a function ARN, read only. The boundary caps it to
	// the parameters of the app's own stacks (`/cdk/EdgeFunctionArn/<region>/<id>…`).
	if (/:ssm:[^:]*:[^:]*:parameter\/cdk\/EdgeFunctionArn\/\*$/.test(arn) && only(['ssm:GetParameter'])) return true;
	// Lists log-group names only (no log data); takes only `log-group:*`.
	if (only(['logs:DescribeLogGroups'])) return true;
	// CDK's log-retention provider grants these on `*`; the boundary caps them to the app's own log groups.
	if (name === '*' && only(['logs:PutRetentionPolicy', 'logs:DeleteRetentionPolicy'])) return true;
	// Bedrock foundation models (`foundation-model/*`, no account) and system-defined
	// inference profiles (`inference-profile/*`) are AWS-owned and hold no app's data;
	// an Agent's loop invokes whichever the app picks. Application inference profiles
	// (`application-inference-profile/…`), custom and imported models stay flagged.
	if (
		/^arn:[^:]*:bedrock:[^:]*:[^:]*:(foundation-model|inference-profile)\/\*$/.test(arn) &&
		only([
			'bedrock:InvokeModel',
			'bedrock:InvokeModelWithResponseStream',
			'bedrock:GetFoundationModel',
			'bedrock:ListFoundationModels',
			'bedrock:GetInferenceProfile',
			'bedrock:ListInferenceProfiles',
		])
	) {
		return true;
	}
	// An Agent's RPC handler invokes its runtimes on `runtime/*`: the runtime runs as
	// the same shared role, so naming its ARN would be a dependency cycle. Runtime ids
	// are generated, and the boundary caps the call to runtimes tagged as the app.
	if (
		/^arn:[^:]*:bedrock-agentcore:[^:]*:[^:]*:runtime\/\*(\/\*)?$/.test(arn) &&
		only(['bedrock-agentcore:InvokeAgentRuntime'])
	) {
		return true;
	}
	// SES sending authorizes against account-level identities and configuration sets
	// that no app's name or tag scopes; EmailClient grants sending only. An accepted
	// exception listed under Limits in SHARED-ACCOUNT.md (one app can send as an
	// identity another app verified).
	if (
		(arn === '*' || /^arn:[^:]*:ses:[^:]*:[^:]*:(identity|configuration-set)\/\*$/.test(arn)) &&
		only(['ses:SendEmail', 'ses:SendRawEmail', 'ses:SendBulkEmail'])
	) {
		return true;
	}
	// AgentCore runtimes write to AWS-named log groups (`/aws/bedrock-agentcore/runtimes/<runtime id>-…`)
	// that can't carry the app's prefix: write access only, which the boundary also allows.
	if (
		name.startsWith('/aws/bedrock-agentcore/runtimes/') &&
		only(['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'])
	) {
		return true;
	}
	return false;
}

/**
 * Check one policy statement. Only `Allow` statements can reach outside the app:
 * - `inverse-grant`: `NotAction`, or `NotResource` on a data service — "everything
 *   except …" reaches every other app;
 * - `unresolvable-grant`: a resource on a data service the check can't see
 *   through (`Fn::Sub`, `Fn::ImportValue`, a `Ref` to a template parameter);
 * - `wildcard-data-grant`: an action on a data service (or `*`) on `*`, or on a
 *   name that starts with `*`, unless a `Condition` scopes it by `aws:ResourceTag`;
 * - `grant-outside-app`: a literal resource name on a data service that isn't
 *   under the app's prefix (a reference inside the name is checked only up to it).
 *
 * @param parameters the template's parameter names (see {@link renderResource}).
 */
export function checkStatement(
	statement: ResolvedStatement,
	id: string,
	where: string,
	parameters: ReadonlySet<string> = new Set(),
): AppViolation[] {
	if (statement.Effect !== 'Allow') return [];
	if (statement.NotAction !== undefined) {
		return [
			{
				rule: 'inverse-grant',
				path: where,
				message: `${where} allows every action except ${asList(statement.NotAction).join(', ')} — that reaches every app.`,
			},
		];
	}
	const actions = asList(statement.Action);
	if (!touchesData(actions)) return [];
	const services = servicesOf(actions);
	if (statement.NotResource !== undefined) {
		return [
			{
				rule: 'inverse-grant',
				path: where,
				message: `${where} grants ${actions.join(', ')} on every resource except the listed ones — that reaches every app.`,
			},
		];
	}
	const out: AppViolation[] = [];
	for (const resource of asList(statement.Resource)) {
		const rendered = renderResource(resource, parameters);
		if (rendered.kind === 'own') continue;
		if (rendered.kind === 'unresolvable') {
			out.push({
				rule: 'unresolvable-grant',
				path: where,
				message:
					`${where} grants ${actions.join(', ')} on ${JSON.stringify(resource)}, which the check can't resolve ` +
					'(Fn::Sub, Fn::ImportValue or a template parameter). Name the resource directly, or reference it.',
			});
			continue;
		}
		const arn = rendered.arn;
		const parsed = arnResourceName(arn);
		if (!parsed) continue;
		if (parsed.service !== '*' && !services.has(parsed.service) && !services.has('*')) continue;
		const name = parsed.name;
		const literal = name.split(TOKEN)[0];
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder shown in messages, not a template
		const label = arn.replaceAll(TOKEN, '${…}');
		if (literal.replace(/^\//, '').startsWith('*')) {
			if (!scopesWildcard(statement.Condition, actions, id) && !isKnownExemption(actions, '*', arn)) {
				out.push({
					rule: 'wildcard-data-grant',
					path: where,
					message: `${where} grants ${actions.join(', ')} on "${label}" — every app's resources, not just this app's.`,
				});
			}
			continue;
		}
		const bare = literal.replace(/^\//, '');
		if (bare === '') continue;
		if (isKnownExemption(actions, literal, arn)) continue;
		// The app's own CDK asset bucket (`cdk-<qualifier>-assets-…`, qualifier = app id).
		if (parsed.service === 's3' && bare.startsWith(`cdk-${id}-assets-`)) continue;
		// Hosting's `config()` (`/blocks/<stackId>/config/…`, SSM) and `secret()`
		// (`blocks/<stackId>/secrets/…`, Secrets Manager) values: the app's own when
		// `stackId` (`.cdk-blocks/config.json`) is the app id; anything else under
		// `blocks/` is another app's, or no app's.
		const hostingStore = (parsed.service === 'ssm' || parsed.service === 'secretsmanager') && /^blocks(\/|$)/.test(bare);
		// A name with a reference in it is checked only up to the reference: the
		// literal part must be under the prefix, or a start of it (`app` + `${…}`).
		const within = hostingStore
			? bare.startsWith(`blocks/${id}/`)
			: name.includes(TOKEN)
				? isUnderAppPrefix(bare, id, parsed.service) || `${id}-`.startsWith(bare)
				: isUnderAppPrefix(bare, id, parsed.service);
		if (!within) {
			const asset = parsed.service === 's3' && /^cdk-[^-]+-assets-/.test(bare);
			const api = parsed.service === 'execute-api' || parsed.service === 'apigateway';
			out.push({
				rule: 'grant-outside-app',
				path: where,
				message: hostingStore
					? `${where} grants ${actions.join(', ')} on Hosting's "${label}", which isn't under this app's ` +
						`"blocks/${id}/" store prefix. Set "stackId" in .cdk-blocks/config.json to "${id}" (the app id), so ` +
						`secret() and config() values live under blocks/${id}/.`
					: api
					? `${where} grants ${actions.join(', ')} on "${label}", a literal API id: API ids aren't app names, so ` +
						"this can be another app's API. Reference the app's own API (its construct) instead."
					: asset
					? `${where} reads the CDK asset bucket "${label}", which isn't this app's: bootstrap the app with ` +
						`--qualifier ${id} and set @aws-cdk/core:bootstrapQualifier to "${id}" in cdk.json.`
					: `${where} grants ${actions.join(', ')} on "${label}", which isn't under this app's prefix "${id}-".`,
			});
		}
	}
	return out;
}

/**
 * Resource-policy resource types, and the property naming the resource each one
 * opens up. A literal name there outside the app's prefix grants another app's
 * resource to someone.
 */
const RESOURCE_POLICY_TARGETS: Record<string, string> = {
	'AWS::Lambda::Permission': 'FunctionName',
	'AWS::SQS::QueuePolicy': 'Queues',
	'AWS::S3::BucketPolicy': 'Bucket',
	'AWS::SecretsManager::ResourcePolicy': 'SecretId',
	'AWS::SNS::TopicPolicy': 'Topics',
};

/** Whether a CloudFormation resource type is a resource policy {@link checkResourcePolicy} checks. */
export function isResourcePolicyType(type: string): boolean {
	return type in RESOURCE_POLICY_TARGETS;
}

/** The resource name in a resource-policy target value: an ARN's name, a queue URL's last segment, or a bare name. */
function targetName(value: string): string {
	const parsed = arnResourceName(value);
	if (parsed) return parsed.name;
	if (/^https:\/\/sqs\./.test(value)) return value.slice(value.lastIndexOf('/') + 1);
	const arn = /^arn:[^:]*:[^:]+:[^:]*:[^:]*:(.*)$/.exec(value);
	return arn ? arn[1].replace(/^[a-z-]+[:/]/, '') : value;
}

/** `resource-policy-outside-app` for a resource policy that opens up another app's resource. */
export function checkResourcePolicy(
	type: string,
	props: Record<string, unknown>,
	id: string,
	where: string,
	parameters: ReadonlySet<string> = new Set(),
): AppViolation[] {
	const key = RESOURCE_POLICY_TARGETS[type];
	if (!key) return [];
	const out: AppViolation[] = [];
	for (const value of asList(props[key] as unknown)) {
		const rendered = renderResource(value, parameters);
		if (rendered.kind === 'own') continue;
		const name = rendered.kind === 'arn' ? targetName(rendered.arn).split(TOKEN)[0] : undefined;
		if (name !== undefined && (name === '' || isUnderAppPrefix(name, id))) continue;
		out.push({
			rule: 'resource-policy-outside-app',
			path: where,
			message:
				name === undefined
					? `${where} (${type}) targets ${JSON.stringify(value)}, which the check can't resolve.`
					: `${where} (${type}) opens up "${name}", which isn't under this app's prefix "${id}-".`,
		});
	}
	return out;
}

/**
 * Resource types whose policy document lets principals in, and the property that
 * holds it. `AWS::Lambda::Permission`, `AWS::Lambda::LayerVersionPermission` and
 * `AWS::Events::EventBusPolicy` hold one statement or name their principal
 * directly, and are read by {@link checkResourcePolicyPrincipals}.
 */
const POLICY_DOCUMENT_OF: Record<string, string> = {
	'AWS::S3::BucketPolicy': 'PolicyDocument',
	'AWS::SQS::QueuePolicy': 'PolicyDocument',
	'AWS::SNS::TopicPolicy': 'PolicyDocument',
	'AWS::SecretsManager::ResourcePolicy': 'ResourcePolicy',
	'AWS::KMS::Key': 'KeyPolicy',
	'AWS::KMS::ReplicaKey': 'KeyPolicy',
	'AWS::ApiGateway::RestApi': 'Policy',
	'AWS::Events::EventBus': 'Policy',
};

/** Condition keys that, matched to the app's own ARNs, pin an "everyone" principal to this app. */
const APP_ARN_CONDITION_KEYS = new Set(['aws:sourcearn', 'aws:principalarn']);

/**
 * Whether an ARN (rendered) is one of the app's own: a reference to its template,
 * or a name under its prefix in this account. The account must be the stack's
 * (`account`), or `AWS::AccountId`; a literal `*` account is every account.
 */
function isOwnArn(value: unknown, id: string, parameters: ReadonlySet<string>, account?: string): boolean {
	const rendered = renderResource(value, parameters);
	if (rendered.kind === 'own') return true;
	if (rendered.kind === 'unresolvable') return false;
	const arnAccount = /^arn:[^:]*:[^:]*:[^:]*:([^:]*):/.exec(rendered.arn)?.[1];
	if (arnAccount === undefined) return false;
	// `AWS::AccountId` renders as `*`; in a literal string, `*` matches every account.
	const thisAccount = arnAccount === '' || arnAccount === account || (arnAccount === '*' && typeof value !== 'string');
	if (!thisAccount) return false;
	const iamRole = /^arn:[^:]*:iam::[^:]*:role\/(?:.*\/)?([^/]+)$/.exec(rendered.arn);
	const name = iamRole ? iamRole[1] : arnResourceName(rendered.arn)?.name;
	if (name === undefined) return false;
	if (name.startsWith(TOKEN)) return true;
	const literal = name.split(TOKEN)[0];
	return !literal.startsWith('*') && isUnderAppPrefix(literal, id, iamRole ? undefined : arnResourceName(rendered.arn)?.service);
}

/**
 * Whether a statement's `Condition` pins everyone (`*`) to this app:
 * `aws:SourceArn` or `aws:PrincipalArn` matched (`ArnEquals`, `ArnLike`,
 * `StringEquals`, `StringLike`) only to the app's own ARNs in this account, or
 * `aws:PrincipalTag/app` equal to the app id together with `aws:PrincipalAccount`
 * equal to this account. The tag alone isn't enough: the caller's own account
 * sets it, so another account can tag its role as this app. The account alone
 * (`aws:SourceAccount`, `aws:PrincipalAccount`, an organization) isn't enough
 * either: every app on the platform shares it.
 */
function conditionPinsToApp(condition: unknown, id: string, parameters: ReadonlySet<string>, account?: string): boolean {
	if (!condition || typeof condition !== 'object') return false;
	let tagPinned = false;
	let accountPinned = false;
	for (const [operator, entries] of Object.entries(condition as Record<string, unknown>)) {
		if (!/^(ArnEquals|ArnLike|StringEquals|StringLike)$/.test(operator) || !entries || typeof entries !== 'object') continue;
		for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
			const values = asList(value as unknown);
			if (values.length === 0) continue;
			const k = key.toLowerCase();
			if (APP_ARN_CONDITION_KEYS.has(k) && values.every((v) => isOwnArn(v, id, parameters, account))) return true;
			if (k === `aws:principaltag/${APP_TAG_KEY}` && values.every((v) => v === id)) tagPinned = true;
			if (k === 'aws:principalaccount' && operator === 'StringEquals' && values.every((v) => isThisAccount(v, account))) {
				accountPinned = true;
			}
		}
	}
	return tagPinned && accountPinned;
}

/** Whether a value names this account: `{ Ref: 'AWS::AccountId' }`, or the stack's literal account. */
function isThisAccount(value: unknown, account?: string): boolean {
	if (value && typeof value === 'object') return (value as { Ref?: unknown }).Ref === 'AWS::AccountId';
	return typeof value === 'string' && account !== undefined && value === account;
}

/** Why an `AWS` principal value isn't this app's, or `undefined` when it is. */
function awsPrincipalOutsideApp(value: unknown, id: string, parameters: ReadonlySet<string>, account?: string): string | undefined {
	// `{ Ref: 'AWS::AccountId' }`: this account, which leaves the decision to IAM (and the boundary).
	if (value && typeof value === 'object' && (value as { Ref?: unknown }).Ref === 'AWS::AccountId') return undefined;
	const rendered = renderResource(value, parameters);
	if (rendered.kind === 'own') return undefined;
	if (rendered.kind === 'unresolvable') return JSON.stringify(value);
	const v = rendered.arn;
	if (v === '*') return '*';
	if (/^\d{12}$/.test(v)) return v === account ? undefined : v;
	const m = /^arn:[^:]*:iam::([^:]*):(.*)$/.exec(v);
	if (!m) return v;
	const [, principalAccount, resource] = m;
	// A pseudo-parameter account renders as `*`; a literal one must be the stack's.
	if (principalAccount !== '*' && principalAccount !== account) return v;
	if (resource === 'root') return undefined;
	return isOwnArn(value, id, parameters, account) ? undefined : v;
}

/** Marks a policy or statement the check can't read, so the report fails closed. */
const UNREADABLE = '\u0000unreadable';

/** Whether a value is a CloudFormation intrinsic (`Fn::If`, `Fn::Join`, `Ref`, …) rather than a literal object. */
function isIntrinsic(value: unknown): boolean {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	return keys.length === 1 && (keys[0] === 'Ref' || keys[0].startsWith('Fn::'));
}

/** The statements in a policy document, or {@link UNREADABLE} when it isn't a literal document with a `Statement`. */
function documentStatements(document: unknown): unknown[] | typeof UNREADABLE {
	if (!document || typeof document !== 'object' || Array.isArray(document) || isIntrinsic(document)) return UNREADABLE;
	const statements = (document as { Statement?: unknown }).Statement;
	if (statements === undefined || statements === null || typeof statements !== 'object' || isIntrinsic(statements)) {
		return UNREADABLE;
	}
	return asList(statements as unknown);
}

/**
 * The principals in one statement that aren't this app's (for an `Allow`; a
 * `Deny` lets no one in). With `everyoneIsPublic`, everyone (`*`) is a public
 * endpoint's anonymous callers, not a principal to fence.
 */
function statementOutsiders(
	statement: unknown,
	id: string,
	parameters: ReadonlySet<string>,
	account?: string,
	everyoneIsPublic = false,
): string[] {
	if (!statement || typeof statement !== 'object' || isIntrinsic(statement)) return [UNREADABLE];
	const st = statement as { Effect?: unknown; Principal?: unknown; NotPrincipal?: unknown; Condition?: unknown };
	if (st.Effect !== 'Allow') return [];
	if (st.NotPrincipal !== undefined) return ['everyone except the NotPrincipal list'];
	// A pin, or a public REST API, lets in everyone (`*`) only: a named principal is judged on its own.
	const everyoneLetIn = everyoneIsPublic || conditionPinsToApp(st.Condition, id, parameters, account);
	if (st.Principal === '*') return everyoneLetIn ? [] : ['*'];
	if (!st.Principal || typeof st.Principal !== 'object') return [];
	const out: string[] = [];
	for (const [kind, values] of Object.entries(st.Principal as Record<string, unknown>)) {
		if (kind === 'Service') continue;
		for (const v of asList(values as unknown)) {
			if (kind === 'AWS' && v === '*') {
				if (!everyoneLetIn) out.push('*');
				continue;
			}
			const outsider =
				kind === 'AWS'
					? awsPrincipalOutsideApp(v, id, parameters, account)
					: renderResource(v, parameters).kind === 'own'
						? undefined
						: `${kind} ${JSON.stringify(v)}`;
			if (outsider !== undefined) out.push(outsider);
		}
	}
	return out;
}

/**
 * `resource-policy-outside-app` for a resource policy that lets in someone who
 * isn't this app: everyone (`*`), another account, another app's role,
 * `NotPrincipal`, a federated or canonical user that isn't the app's own, or a
 * public Lambda function URL. A service principal is fine (the service-principal
 * check covers its source conditions), and so is this account's root, which
 * leaves the decision to IAM and the boundary. "Everyone" is fine only when a
 * condition pins it to the app's own ARNs or app tag, or on an API Gateway REST
 * API, where it means a public API's anonymous callers. Covers Lambda and layer
 * permissions, and bucket, queue, topic, secret, KMS key and replica key, API
 * Gateway REST API and EventBridge bus policies, in every stack the report reads.
 * A policy the check can't read (an intrinsic, a string) fails closed.
 */
export function checkResourcePolicyPrincipals(
	type: string,
	props: Record<string, unknown>,
	id: string,
	where: string,
	parameters: ReadonlySet<string> = new Set(),
	account?: string,
): AppViolation[] {
	let outsiders: string[];
	if (type === 'AWS::Lambda::Permission' || type === 'AWS::Lambda::LayerVersionPermission') {
		const principal = props.Principal;
		if (typeof principal === 'string' && /\.amazonaws\.com(\.cn)?$/.test(principal)) return [];
		// A function URL that requires IAM auth still needs the caller's own IAM permission.
		if (principal === '*' && props.FunctionUrlAuthType === 'AWS_IAM') return [];
		const pinned = isOwnArn(props.SourceArn, id, parameters, account);
		const outsider = principal === '*' ? '*' : awsPrincipalOutsideApp(principal, id, parameters, account);
		outsiders = outsider !== undefined && !(principal === '*' && pinned) ? [outsider] : [];
	} else if (type === 'AWS::Events::EventBusPolicy') {
		// One statement (`Statement`), or the legacy form that names the principal (an account id or `*`) directly.
		if (props.Statement !== undefined) {
			outsiders = statementOutsiders(props.Statement, id, parameters, account);
		} else {
			const principal = props.Principal;
			const statement = { Effect: 'Allow', Principal: principal === '*' ? '*' : { AWS: principal }, Condition: props.Condition };
			outsiders = principal === undefined ? [] : statementOutsiders(statement, id, parameters, account);
		}
	} else {
		const key = POLICY_DOCUMENT_OF[type];
		if (!key) return [];
		const document = props[key];
		if (document === undefined || document === null) return [];
		// A REST API's policy lets in `*` for a public API (Hosting's origin-verify policy
		// does, and denies requests without CloudFront's secret header): anonymous web
		// callers aren't IAM principals, and runtime API calls aren't isolated (README,
		// Limits). Another account or another app's role there is still flagged.
		const everyoneIsPublic = type === 'AWS::ApiGateway::RestApi';
		const statements = documentStatements(document);
		outsiders =
			statements === UNREADABLE
				? [UNREADABLE]
				: statements.flatMap((st) => statementOutsiders(st, id, parameters, account, everyoneIsPublic));
	}
	if (outsiders.length === 0) return [];
	if (outsiders.includes(UNREADABLE)) {
		return [
			{
				rule: 'resource-policy-outside-app',
				path: where,
				message:
					`${where} (${type}) has a policy the check can't read (an intrinsic such as Fn::If, or a string), ` +
					'so it may let anyone in. Write it as a literal policy document.',
			},
		];
	}
	return [
		{
			rule: 'resource-policy-outside-app',
			path: where,
			message:
				`${where} (${type}) lets in ${[...new Set(outsiders)].join(', ')}, which isn't this app. Grant this ` +
				"app's own roles (or a service), or pin the statement to this app with aws:SourceArn or aws:PrincipalArn " +
				`on its own ARNs, or aws:PrincipalTag/app = "${id}".`,
		},
	];
}

/**
 * Name-fenced resource types: the property holding the name the app may give a
 * resource, and the service whose name rule applies ({@link isUnderAppPrefix}).
 * The boundary and execution policy match these by `<id>-…` (parameters also by
 * `<id>` and `<id>/…`), so a name outside that is refused at deploy time.
 */
const PHYSICAL_NAME_OF: Record<string, readonly [property: string, service: string]> = {
	'AWS::DynamoDB::Table': ['TableName', 'dynamodb'],
	'AWS::DynamoDB::GlobalTable': ['TableName', 'dynamodb'],
	'AWS::SQS::Queue': ['QueueName', 'sqs'],
	'AWS::S3::Bucket': ['BucketName', 's3'],
	'AWS::Lambda::Function': ['FunctionName', 'lambda'],
	'AWS::Lambda::LayerVersion': ['LayerName', 'lambda'],
	'AWS::SSM::Parameter': ['Name', 'ssm'],
	'AWS::Logs::LogGroup': ['LogGroupName', 'logs'],
	'AWS::RDS::DBCluster': ['DBClusterIdentifier', 'rds'],
	'AWS::RDS::DBInstance': ['DBInstanceIdentifier', 'rds'],
	'AWS::S3Vectors::VectorBucket': ['VectorBucketName', 's3vectors'],
	'AWS::Events::Rule': ['Name', 'events'],
	'AWS::Events::EventBus': ['Name', 'events'],
	'AWS::Scheduler::Schedule': ['Name', 'scheduler'],
	'AWS::SecretsManager::Secret': ['Name', 'secretsmanager'],
	'AWS::StepFunctions::StateMachine': ['StateMachineName', 'states'],
};

/** Whether `name`, given to a resource of `service`, is one the platform's policies let this app create. */
function isOwnPhysicalName(service: string, name: string, id: string): boolean {
	switch (service) {
		case 'logs':
			// Lambda's and RDS's log groups carry the function's or cluster's name.
			return isUnderAppPrefix(name.replace(/^\/aws\/(lambda|rds\/cluster)\//, ''), id);
		case 'ssm':
			// Hosting's config() values and CDK's Lambda@Edge ARNs are the app's own too.
			return (
				isUnderAppPrefix(name, id, 'ssm') ||
				name.replace(/^\//, '').startsWith(`blocks/${id}/`) ||
				/^\/?cdk\/EdgeFunctionArn\/[^/]+\/([^/]+)\//.exec(name)?.[1] === id
			);
		case 'rds':
			// RDS stores identifiers in lowercase.
			return isUnderAppPrefix(name.toLowerCase(), id);
		case 'secretsmanager':
			// Hosting's secret() values (`blocks/<id>/…`) are the app's own too.
			return isUnderAppPrefix(name, id) || name.startsWith(`blocks/${id}/`);
		default:
			return isUnderAppPrefix(name, id);
	}
}

/**
 * `scope-outside-app` when the app gives a name-fenced resource (a table, queue,
 * bucket, function, layer, parameter, log group, RDS cluster or instance, vector
 * bucket, event rule or bus, schedule, secret or state machine) a literal name
 * outside its prefix. A
 * reference to one of the app's own resources counts as its own whatever its
 * name, so the name itself is checked here; the execution policy would refuse
 * to create it anyway. A name with a reference or pseudo parameter in it, or no
 * name (CloudFormation generates one from the stack name), isn't judged.
 */
export function checkPhysicalName(type: string, props: Record<string, unknown>, id: string, where: string): AppViolation[] {
	const fenced = PHYSICAL_NAME_OF[type];
	if (!fenced) return [];
	const [property, service] = fenced;
	const value = props[property];
	if (value === undefined || value === null || value === '') return [];
	const rendered = renderResource(value);
	if (rendered.kind !== 'arn' || rendered.arn.includes(TOKEN) || rendered.arn.includes('*')) return [];
	if (isOwnPhysicalName(service, rendered.arn, id)) return [];
	return [
		{
			rule: 'scope-outside-app',
			path: where,
			message:
				`${where} names its ${type} "${rendered.arn}" (${property}), which isn't under this app's prefix ` +
				`"${id}-": the platform's execution policy refuses to create it. Name it "${id}-…", or leave the name out.`,
		},
	];
}

/** AWS managed policies too broad for an app role on a shared account. */
const BROAD_MANAGED_POLICY = /:aws:policy\/(AdministratorAccess|PowerUserAccess|IAMFullAccess|ReadOnlyAccess|[A-Za-z0-9]*FullAccess)$/;

/** `broad-managed-policy` for each AWS managed policy ARN in `arns` that grants account-wide access. */
function checkManagedPolicies(arns: unknown[], where: string): AppViolation[] {
	const out: AppViolation[] = [];
	for (const value of arns) {
		const rendered = renderResource(value);
		const arn = rendered.kind === 'arn' ? rendered.arn : undefined;
		if (arn && BROAD_MANAGED_POLICY.test(arn)) {
			out.push({
				rule: 'broad-managed-policy',
				path: where,
				message: `${where} attaches ${arn.replace(/^arn:[^:]*:/, 'arn:…:')}, which reaches every app's resources.`,
			});
		}
	}
	return out;
}

/** The value of the `app` tag in a resolved `Tags` list, `undefined` when absent, `null` when not a literal. */
export function appTagValue(tags: unknown): string | null | undefined {
	for (const tag of asList(tags as unknown[] | undefined)) {
		if (tag && typeof tag === 'object' && (tag as { Key?: unknown }).Key === APP_TAG_KEY) {
			const value = (tag as { Value?: unknown }).Value;
			return typeof value === 'string' ? value : null;
		}
	}
	return undefined;
}

/** Check a role's resolved `Properties`: its trust policy, the boundary (when one is expected), the `app` tag, and its policies. */
export function checkRole(
	props: Record<string, unknown>,
	id: string,
	where: string,
	boundaryExpected: boolean,
	parameters: ReadonlySet<string> = new Set(),
): AppViolation[] {
	const out: AppViolation[] = [];
	// Only AWS services may assume an app's roles: a role an account, user or
	// federated identity can assume hands the app's access to someone outside it.
	const trust = props.AssumeRolePolicyDocument as { Statement?: ResolvedStatement[] } | undefined;
	for (const s of asList(trust?.Statement)) {
		if (s.Effect !== 'Allow') continue;
		const principal = s.Principal;
		const services = principal && typeof principal === 'object' ? Object.keys(principal) : [];
		if (principal === '*' || services.some((k) => k !== 'Service')) {
			out.push({
				rule: 'role-trust-not-service',
				path: where,
				message: `${where} can be assumed by ${JSON.stringify(principal)}; an app's roles may trust only AWS services.`,
			});
		}
	}
	if (boundaryExpected && (props.PermissionsBoundary === undefined || props.PermissionsBoundary === null)) {
		out.push({ rule: 'role-without-boundary', path: where, message: `${where} has no permissions boundary.` });
	}
	const tag = appTagValue(props.Tags);
	if (tag !== id) {
		out.push({
			rule: 'role-tag-mismatch',
			path: where,
			message:
				tag === undefined
					? `${where} has no "${APP_TAG_KEY}" tag; expected "${id}".`
					: `${where} is tagged ${APP_TAG_KEY}=${tag === null ? '(not a literal)' : `"${tag}"`}; expected "${id}".`,
		});
	}
	for (const policy of asList(props.Policies as unknown[] | undefined)) {
		const doc = (policy as { PolicyDocument?: { Statement?: ResolvedStatement[] } }).PolicyDocument;
		for (const s of asList(doc?.Statement)) out.push(...checkStatement(s, id, where, parameters));
	}
	out.push(...checkManagedPolicies(asList(props.ManagedPolicyArns as unknown[] | undefined), where));
	return out;
}

/** `stack-name-outside-app` when a stack name doesn't start with the app's prefix. */
export function checkStackName(stackName: string, id: string): AppViolation[] {
	if (stackName === id || stackName.startsWith(`${id}-`)) return [];
	return [
		{
			rule: 'stack-name-outside-app',
			path: stackName,
			message:
				`Stack "${stackName}" doesn't start with the app id "${id}": CloudFormation-generated names ` +
				`(functions, roles, buckets) start with the stack name, so they'd fall outside "${id}-*". ` +
				`Name the stack "${id}" or "${id}-…".`,
		},
	];
}

/** `scope-outside-app` when a Building Block's `fullId` (which its resource names derive from) is outside the prefix. */
export function checkScopeFullId(fullId: string, id: string, where: string): AppViolation[] {
	if (fullId === id || fullId.startsWith(`${id}-`)) return [];
	return [
		{
			rule: 'scope-outside-app',
			path: where,
			message:
				`Building Block "${fullId}" isn't under the app id "${id}": its resource names derive from its fullId, ` +
				`which starts with the stack's id. Name the stack "${id}" or "${id}-…", and build every block under it.`,
		},
	];
}

/**
 * `api-outside-app` for an API Gateway child resource (a stage, deployment,
 * route, resource, method, integration, …) whose parent API isn't a reference to
 * an API in the app's own template: a literal API id, or one the check can't
 * resolve, can be another app's API — a deployment-control and traffic-routing
 * escape even without any `execute-api` access.
 */
export function checkApiChild(
	type: string,
	props: Record<string, unknown>,
	_id: string,
	where: string,
	parameters: ReadonlySet<string> = new Set(),
): AppViolation[] {
	if (!type.startsWith('AWS::ApiGateway::') && !type.startsWith('AWS::ApiGatewayV2::')) return [];
	const parent = props.RestApiId ?? props.ApiId;
	if (parent === undefined) return [];
	if (renderResource(parent, parameters).kind === 'own') return [];
	return [
		{
			rule: 'api-outside-app',
			path: where,
			message:
				`${where} (${type}) attaches to API ${JSON.stringify(parent)}, which isn't an API in this app's own template. ` +
				"Reference the app's own API instead of an API id.",
		},
	];
}
