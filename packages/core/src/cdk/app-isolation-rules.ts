// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The app-isolation rules behind `defaults.app`: pure functions over
 * CloudFormation-resolved JSON (no `aws-cdk-lib`), so the synth-time IAM report
 * and the `blocks-iam-check` CLI apply exactly the same checks — the CLI to the
 * synthesized templates, which a malicious app can't fake the way it could fake
 * the report its own synth writes.
 *
 * Every rule answers "does this reach outside the app?". An app's resources are
 * the ones whose name starts with the app's prefix: `<id>` followed by `-`, `/`
 * or the end of the name (`appa`, `appa-notes`, `/appa/key`). The id can't
 * contain `-`, so `appa-*` never matches another app (`appab-…`). Two namespaces
 * AWS Blocks and CDK pick count the same way: a cross-region reference's SSM
 * parameter (`/cdk/exports/<consumer stack>/…`, checked by the stack name), and
 * Hosting's `secret()` / `config()` values (`blocks/<stackId>/…`, the app's own
 * only when `stackId` is the app id).
 *
 * These checks are fast feedback, not the boundary: the boundary is IAM.
 *
 * @internal
 */

/** The tag key AWS Blocks stamps with the app id (mirrors `BLOCKS_APP_TAG_KEY`). */
export const APP_TAG_KEY = 'app';

/**
 * `defaults.app.id`: lowercase letters and digits, starting with a letter, 1–10
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
 * out). These ids turn such a pattern into a namespace other apps, AWS Blocks,
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
	blocks: "AWS Blocks' namespace: every app's Hosting `secret()` / `config()` values (`blocks/<id>/…`)",
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
	// the region group's regions, including an app's own from before it set `defaults.app`.
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
 * place that takes an app id uses (`defaults.app.id`, `blocks-iam-policies --app`,
 * `blocks-iam-check --app` and the ids in IAM reports).
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

/** Whether `id` is a usable app id (see {@link appIdProblem}). */
export function isValidAppId(id: unknown): id is string {
	return appIdProblem(id) === undefined;
}

/** What a violation is about. */
export type AppViolationRule =
	| 'no-permissions-boundary'
	| 'role-without-boundary'
	| 'role-tag-mismatch'
	| 'role-trust-not-service'
	| 'stack-tag-mismatch'
	| 'stack-name-outside-app'
	| 'scope-outside-app'
	| 'grant-outside-app'
	| 'inverse-grant'
	| 'unresolvable-grant'
	| 'wildcard-data-grant'
	| 'broad-managed-policy'
	| 'resource-policy-outside-app'
	| 'unreadable-template'
	| 'template-transform'
	| 'layer-outside-app'
	| 'api-outside-app'
	| 'app-id-mismatch'
	| 'invalid-app-id';

/** One finding. `path` is the construct path (synth) or `<stack>/<logicalId>` (CLI). */
export interface AppViolation {
	rule: AppViolationRule;
	message: string;
	path?: string;
}

/** Whether `name` belongs to app `id` (see the module doc). */
export function isUnderAppPrefix(name: string, id: string): boolean {
	const n = name.startsWith('/') ? name.slice(1) : name;
	return n === id || n.startsWith(`${id}-`) || n.startsWith(`${id}/`);
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
			name = after('function:', ':');
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
		case 'execute-api':
			// `<api id>/<stage>/<method>/<path>`: an API id is never a name under the app's
			// prefix, so a literal one is always outside the app — reference the API instead.
			name = rest.split('/')[0];
			break;
		default:
			// cognito-idp and kms name resources by id, not by name: only `*` is checked.
			name = undefined;
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

function servicesOf(actions: string[]): Set<string> {
	return new Set(actions.map((a) => (a === '*' ? '*' : a.split(':')[0].toLowerCase())));
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
 * Grants AWS Blocks or CDK make that name resources outside the app's prefix,
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
		// `stackId` (`.blocks/config.json`) is the app id; anything else under
		// `blocks/` is another app's, or no app's.
		const hostingStore = (parsed.service === 'ssm' || parsed.service === 'secretsmanager') && /^blocks(\/|$)/.test(bare);
		// A name with a reference in it is checked only up to the reference: the
		// literal part must be under the prefix, or a start of it (`app` + `${…}`).
		const within = hostingStore
			? bare.startsWith(`blocks/${id}/`)
			: name.includes(TOKEN)
				? isUnderAppPrefix(bare, id) || `${id}-`.startsWith(bare)
				: isUnderAppPrefix(bare, id);
		if (!within) {
			const asset = parsed.service === 's3' && /^cdk-[^-]+-assets-/.test(bare);
			const api = parsed.service === 'execute-api' || parsed.service === 'apigateway';
			out.push({
				rule: 'grant-outside-app',
				path: where,
				message: hostingStore
					? `${where} grants ${actions.join(', ')} on Hosting's "${label}", which isn't under this app's ` +
						`"blocks/${id}/" store prefix. Set "stackId" in .blocks/config.json to "${id}" (the app id), so ` +
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

/** AWS managed policies too broad for an app role on a shared account. */
const BROAD_MANAGED_POLICY = /:aws:policy\/(AdministratorAccess|PowerUserAccess|IAMFullAccess|ReadOnlyAccess|[A-Za-z0-9]*FullAccess)$/;

/** `broad-managed-policy` for each AWS managed policy ARN in `arns` that grants account-wide access. */
export function checkManagedPolicies(arns: unknown[], where: string): AppViolation[] {
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
	if (isUnderAppPrefix(stackName, id) && !stackName.startsWith(`${id}/`)) return [];
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

/** Whether `value` contains an `Fn::Transform` anywhere. */
function hasFnTransform(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(hasFnTransform);
	if (!value || typeof value !== 'object') return false;
	return Object.entries(value).some(([k, v]) => k === 'Fn::Transform' || hasFnTransform(v));
}

/**
 * `template-transform` when a template has a top-level `Transform` (a macro,
 * `AWS::Include`, `AWS::Serverless`) or an `Fn::Transform`: CloudFormation
 * expands them at deploy time, after the check ran, so what's checked isn't what
 * gets deployed.
 */
export function checkTransforms(template: { Transform?: unknown } & Record<string, unknown>, where: string): AppViolation[] {
	const transforms = template.Transform === undefined ? [] : Array.isArray(template.Transform) ? template.Transform : [template.Transform];
	if (transforms.length === 0 && !hasFnTransform(template)) return [];
	return [
		{
			rule: 'template-transform',
			path: where,
			message:
				`${where} uses a CloudFormation transform (${transforms.length > 0 ? transforms.join(', ') : 'Fn::Transform'}), ` +
				"which adds resources at deploy time that the check can't see. Remove it.",
		},
	];
}

/**
 * `layer-outside-app` for a Lambda layer whose name isn't under the app's prefix:
 * the platform scopes layer operations by name, so an unprefixed layer name is
 * either another app's or one the execution policy won't let the app manage.
 */
export function checkLayer(props: Record<string, unknown>, id: string, where: string): AppViolation[] {
	const name = renderResource(props.LayerName);
	if (name.kind === 'arn' && isUnderAppPrefix(name.arn.split(TOKEN)[0], id)) return [];
	if (name.kind === 'arn' && name.arn.startsWith(TOKEN)) return [];
	return [
		{
			rule: 'layer-outside-app',
			path: where,
			message: `${where} is a Lambda layer named ${JSON.stringify(props.LayerName ?? null)}, which isn't under this app's prefix "${id}-".`,
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
