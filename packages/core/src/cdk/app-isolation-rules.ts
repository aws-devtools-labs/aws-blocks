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
 * contain `-`, so `appa-*` never matches another app (`appab-…`).
 *
 * These checks are fast feedback, not the boundary: the boundary is IAM.
 *
 * @internal
 */

/** The tag key AWS Blocks stamps with the app id (mirrors `BLOCKS_APP_TAG_KEY`). */
export const APP_TAG_KEY = 'app';

/** `defaults.app.id`: lowercase letters and digits, starting with a letter, 1–32 characters. */
export const APP_ID_PATTERN = /^[a-z][a-z0-9]{0,31}$/;

/** What a violation is about. */
export type AppViolationRule =
	| 'no-permissions-boundary'
	| 'role-without-boundary'
	| 'role-tag-mismatch'
	| 'stack-tag-mismatch'
	| 'stack-name-outside-app'
	| 'scope-outside-app'
	| 'grant-outside-app'
	| 'wildcard-data-grant'
	| 'broad-managed-policy'
	| 'app-id-mismatch';

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
 * Data services an app reaches other apps' data through. A grant on one of these
 * outside the app's prefix, or on `*`, is a violation.
 */
const DATA_SERVICES = new Set(['ssm', 'dynamodb', 'sqs', 's3', 'secretsmanager', 'lambda']);

/** Lambda actions that act on a function another app owns (invoking it, or changing it). */
const LAMBDA_DATA_ACTION = /^lambda:(Invoke|Update|Delete|Put|Add|Remove|\*)/i;

/** Placeholder for a CloudFormation intrinsic inside a rendered ARN. */
const TOKEN = '\u0000';

/**
 * Render a resolved `Resource` value to a string ARN, with any non-literal part
 * (a `Ref`, `Fn::GetAtt`, …) replaced by a placeholder. `Ref`s to pseudo
 * parameters (partition, region, account) become `*` — they don't name a
 * resource. Returns `undefined` for a value that names one of the app's own
 * resources by reference (`{ Ref: … }`, `Fn::GetAtt`): those are never another
 * app's.
 */
export function renderArn(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (!value || typeof value !== 'object') return undefined;
	const obj = value as Record<string, unknown>;
	if (typeof obj.Ref === 'string') return obj.Ref.startsWith('AWS::') ? '*' : undefined;
	const join = obj['Fn::Join'];
	if (Array.isArray(join) && typeof join[0] === 'string' && Array.isArray(join[1])) {
		const parts = (join[1] as unknown[]).map((p) => {
			if (typeof p === 'string') return p;
			if (p && typeof p === 'object' && typeof (p as { Ref?: unknown }).Ref === 'string') {
				return ((p as { Ref: string }).Ref.startsWith('AWS::') ? '*' : TOKEN) as string;
			}
			return TOKEN;
		});
		return parts.join(join[0]);
	}
	return undefined;
}

/** The service and the resource-name part of an ARN, or `undefined` for a non-ARN / unsupported service. */
function arnResourceName(arn: string): { service: string; name: string } | undefined {
	if (arn === '*') return { service: '*', name: '*' };
	const m = /^arn:[^:]*:([^:]+):[^:]*:[^:]*:(.*)$/.exec(arn);
	if (!m) return undefined;
	const service = m[1];
	const rest = m[2];
	switch (service) {
		case 'ssm':
			return rest.startsWith('parameter') ? { service, name: rest.slice('parameter'.length) } : undefined;
		case 'dynamodb':
			return rest.startsWith('table/') ? { service, name: rest.slice('table/'.length).split('/')[0] } : undefined;
		case 'sqs':
			return { service, name: rest };
		case 's3':
			return { service, name: rest.split('/')[0] };
		case 'secretsmanager':
			return rest.startsWith('secret:') ? { service, name: rest.slice('secret:'.length) } : undefined;
		case 'lambda':
			return rest.startsWith('function:') ? { service, name: rest.slice('function:'.length).split(':')[0] } : undefined;
		default:
			return undefined;
	}
}

/** Statement as found in a resolved policy document. */
export interface ResolvedStatement {
	Sid?: string;
	Effect?: string;
	Action?: string | string[];
	Resource?: unknown;
	Condition?: unknown;
}

const asList = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function servicesOf(actions: string[]): Set<string> {
	return new Set(actions.map((a) => (a === '*' ? '*' : a.split(':')[0].toLowerCase())));
}

function touchesData(actions: string[]): boolean {
	return actions.some((a) => {
		if (a === '*') return true;
		const service = a.split(':')[0].toLowerCase();
		if (!DATA_SERVICES.has(service)) return false;
		return service !== 'lambda' || LAMBDA_DATA_ACTION.test(a);
	});
}

/**
 * Check one policy statement. Only `Allow` statements can reach outside the app:
 * - `wildcard-data-grant`: an action on a data service (or `*`) on `*`, or on a
 *   name that starts with `*`, with no `Condition`;
 * - `grant-outside-app`: a literal resource name on a data service that isn't
 *   under the app's prefix (an intrinsic inside the name is checked only up to
 *   the intrinsic).
 */
export function checkStatement(statement: ResolvedStatement, id: string, where: string): AppViolation[] {
	if (statement.Effect !== 'Allow') return [];
	const actions = asList(statement.Action);
	if (!touchesData(actions)) return [];
	const services = servicesOf(actions);
	const out: AppViolation[] = [];
	for (const resource of asList(statement.Resource)) {
		const arn = renderArn(resource);
		if (arn === undefined) continue;
		const parsed = arnResourceName(arn);
		if (!parsed) continue;
		if (parsed.service !== '*' && !services.has(parsed.service) && !services.has('*')) continue;
		const name = parsed.name;
		const literal = name.split(TOKEN)[0];
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder shown in messages, not a template
		const label = arn.replaceAll(TOKEN, '${…}');
		if (literal.replace(/^\//, '').startsWith('*')) {
			if (statement.Condition === undefined) {
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
		// A name with an intrinsic in it is checked only up to the intrinsic: the
		// literal part must be under the prefix, or a start of it (`app` + `${…}`).
		const within = name.includes(TOKEN)
			? isUnderAppPrefix(bare, id) || `${id}-`.startsWith(bare)
			: isUnderAppPrefix(bare, id);
		if (!within) {
			out.push({
				rule: 'grant-outside-app',
				path: where,
				message: `${where} grants ${actions.join(', ')} on "${label}", which isn't under this app's prefix "${id}-".`,
			});
		}
	}
	return out;
}

/** AWS managed policies too broad for an app role on a shared account. */
const BROAD_MANAGED_POLICY = /:aws:policy\/(AdministratorAccess|PowerUserAccess|IAMFullAccess|ReadOnlyAccess|[A-Za-z0-9]*FullAccess)$/;

/** `broad-managed-policy` for each AWS managed policy ARN in `arns` that grants account-wide access. */
export function checkManagedPolicies(arns: unknown[], where: string): AppViolation[] {
	const out: AppViolation[] = [];
	for (const value of arns) {
		const arn = renderArn(value);
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

/** Check a role's resolved `Properties`: the boundary (when one is expected) and the `app` tag. */
export function checkRole(
	props: Record<string, unknown>,
	id: string,
	where: string,
	boundaryExpected: boolean,
): AppViolation[] {
	const out: AppViolation[] = [];
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
		for (const s of asList(doc?.Statement)) out.push(...checkStatement(s, id, where));
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
