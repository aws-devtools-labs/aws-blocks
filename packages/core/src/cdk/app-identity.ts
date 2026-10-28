// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `defaults.app` — an app's identity on a shared app platform (see the field doc
 * on `BlocksDefaults.app`). This module validates the identity, stamps the `app`
 * tag on everything AWS Blocks creates, and collects the app-isolation
 * violations the IAM report lists (rules in `app-isolation-rules.ts`).
 *
 * @internal
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct, IConstruct } from 'constructs';
import {
	APP_ID_PATTERN,
	type AppViolation,
	checkApiChild,
	checkResourcePolicy,
	checkRole,
	isResourcePolicyType,
	checkScopeFullId,
	checkStackName,
	checkStatement,
	type ResolvedStatement,
} from './app-isolation-rules.js';
import { BLOCKS_APP_TAG_KEY, type BlocksAppIdentity, type BlocksDefaults } from './blocks-defaults.js';
import { forEachBlocksRole } from './blocks-roles.js';
import { resolvePermissionsBoundary } from './permissions-boundary.js';
import { findBackendRoot } from './root-registry.js';

/**
 * Tag priority for the `app` tag: above `Tags.of(...).add()`'s default (100), so
 * an app's ordinary tagging doesn't replace it. An app can still raise its own
 * priority or remove the tag; the platform's execution role rejects the result.
 */
const APP_TAG_PRIORITY = 1000;

/**
 * The app identity of the backend root that owns `scope`, validated, or
 * `undefined` when `defaults.app` is unset. **The single resolution point** —
 * nothing else reads `defaults.app`.
 *
 * @throws Error when `defaults.app.id` isn't a valid app id.
 */
export function resolveAppIdentity(scope: Construct): BlocksAppIdentity | undefined {
	const root = findBackendRoot(scope);
	const app = (root as { defaults?: BlocksDefaults } | undefined)?.defaults?.app;
	if (app === undefined) return undefined;
	if (!app || typeof app.id !== 'string' || !APP_ID_PATTERN.test(app.id)) {
		throw new Error(
			`Invalid defaults.app.id: ${JSON.stringify(app?.id)}. An app id is 1–10 lowercase letters and digits, ` +
				'starting with a letter (e.g. "orders" or "app42"). No hyphens: the id is the name prefix ' +
				'("<id>-…") that keeps one app away from another app\'s resources. At most 10 characters: the id is ' +
				'also the app\'s CDK bootstrap qualifier, which CDK limits to 10.',
		);
	}
	return app;
}

/**
 * Stamp `app=<id>` on every resource under `root` and on every IAM role AWS
 * Blocks creates for it (including roles in helper stacks, through the shared
 * role visitor), and warn when no permissions boundary is set. No-op when
 * `defaults.app` is unset. Called from `setupBlocksInfra`.
 */
export function applyAppIdentity(root: Construct): BlocksAppIdentity | undefined {
	const app = resolveAppIdentity(root);
	if (!app) return undefined;
	cdk.Tags.of(root).add(BLOCKS_APP_TAG_KEY, app.id, { priority: APP_TAG_PRIORITY });
	forEachBlocksRole(root, (role) => tagRole(role, app.id));
	nameLayersForApp(cdk.Stack.of(root), app.id);
	if (!resolvePermissionsBoundary(root)) {
		cdk.Annotations.of(root).addWarningV2(
			'blocks:app:noPermissionsBoundary',
			`defaults.app is set ("${app.id}") but defaults.permissionsBoundary isn't. On a shared account, the ` +
				"boundary is what stops this app's roles from reaching another app's resources. Set " +
				"defaults.permissionsBoundary to the platform's boundary policy (see `blocks-iam-policies`).",
		);
	}
	return app;
}

/** Max length of a Lambda layer name. */
const LAYER_NAME_MAX = 140;

/**
 * Name every Lambda layer in the app's stack `<id>-<logical id>` when it has no
 * name of its own. CDK's layers (e.g. the AWS CLI layer `BucketDeployment`
 * uses) otherwise get CloudFormation-generated names that don't carry the app's
 * prefix, so a platform couldn't scope layer operations to one app.
 */
function nameLayersForApp(stack: cdk.Stack, id: string): void {
	cdk.Aspects.of(stack).add({
		visit(node) {
			if (!cdk.CfnResource.isCfnResource(node) || node.cfnResourceType !== 'AWS::Lambda::LayerVersion') return;
			const layerStack = cdk.Stack.of(node);
			// An L2 LayerVersion's name is a token that resolves to nothing unless a
			// name was given (or one is generated for a cross-environment reference).
			const props = (node as unknown as { _cfnProperties?: { LayerName?: unknown; layerName?: unknown } })._cfnProperties;
			const named = layerStack.resolve((node as { layerName?: unknown }).layerName ?? props?.LayerName ?? props?.layerName);
			if (named !== undefined && named !== null && named !== '') return;
			node.addPropertyOverride(
				'LayerName',
				cdk.Lazy.string({
					produce: () => `${id}-${layerStack.resolve(node.logicalId)}`.slice(0, LAYER_NAME_MAX),
				}),
			);
		},
	});
}

/**
 * Put `app=<id>` on one role. A `CfnRole` is taggable; a CDK custom-resource
 * provider's role (e.g. the S3 auto-delete provider) is a raw `CfnResource` that
 * no tag aspect reaches, so its `Tags` property is set directly, keeping any
 * other tags it has.
 */
function tagRole(role: cdk.CfnResource, id: string): void {
	if (cdk.TagManager.isTaggable(role)) {
		role.tags.setTag(BLOCKS_APP_TAG_KEY, id, APP_TAG_PRIORITY);
		return;
	}
	const props = (role as unknown as { _cfnProperties?: { Tags?: unknown } })._cfnProperties;
	const others = asArray(props?.Tags as unknown[] | undefined).filter(
		(t) => !(t && typeof t === 'object' && (t as { Key?: unknown }).Key === BLOCKS_APP_TAG_KEY),
	);
	role.addPropertyOverride('Tags', [...others, { Key: BLOCKS_APP_TAG_KEY, Value: id }]);
}

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** The Building Blocks (any construct with a string `fullId`) under `root`, excluding `root` itself. */
function blocksUnder(root: Construct): { node: IConstruct; fullId: string }[] {
	const out: { node: IConstruct; fullId: string }[] = [];
	for (const node of root.node.findAll()) {
		if (node === root) continue;
		const fullId = (node as { fullId?: unknown }).fullId;
		if (typeof fullId === 'string') out.push({ node, fullId });
	}
	return out;
}

/**
 * Every app-isolation violation for `root`, given the roles AWS Blocks created
 * for it (`roles`, already finalized) and a renderer for their template
 * properties. Must run at synthesis (from the IAM report's hook), after every
 * aspect.
 */
export function collectAppViolations(
	root: Construct,
	app: BlocksAppIdentity,
	roles: readonly cdk.CfnResource[],
	render: (role: cdk.CfnResource) => Record<string, unknown>,
): AppViolation[] {
	const violations: AppViolation[] = [];
	const boundary = resolvePermissionsBoundary(root);
	if (!boundary) {
		violations.push({
			rule: 'no-permissions-boundary',
			path: root.node.path,
			message: 'defaults.permissionsBoundary is unset, so nothing caps what the app\'s roles can reach.',
		});
	}

	// Building Block names derive from the stack's construct id (a BlocksStack)
	// or its name (a BlocksBackend); CloudFormation-generated names from its name.
	const rootStack = cdk.Stack.of(root);
	violations.push(...checkStackName(rootStack.stackName, app.id));
	if (rootStack.node.id !== rootStack.stackName) violations.push(...checkStackName(rootStack.node.id, app.id));

	const seenFullIds = new Set<string>();
	for (const { node, fullId } of blocksUnder(root)) {
		if (seenFullIds.has(fullId)) continue;
		seenFullIds.add(fullId);
		violations.push(...checkScopeFullId(fullId, app.id, node.node.path));
	}

	// A `Ref` to a template parameter is a value the deployer supplies, not one of
	// the app's own resources, so the rules treat it as unresolvable.
	const parametersOf = (stack: cdk.Stack) =>
		new Set(
			stack.node
				.findAll()
				.filter((n): n is cdk.CfnParameter => n instanceof cdk.CfnParameter && cdk.Stack.of(n) === stack)
				.map((n) => n.logicalId),
		);

	// Roles: trust policy, boundary, `app` tag, inline policies, managed policies.
	const roleIdsByStack = new Map<cdk.Stack, Set<string>>();
	for (const role of roles) {
		const stack = cdk.Stack.of(role);
		const ids = roleIdsByStack.get(stack) ?? new Set<string>();
		ids.add(stack.resolve(role.logicalId) as string);
		roleIdsByStack.set(stack, ids);
		violations.push(
			...checkRole(render(role), app.id, role.node.path, boundary !== undefined, parametersOf(stack)),
		);
	}

	// Resource policies under the root (Lambda permissions, queue / bucket / secret /
	// topic policies) that open up a resource outside the app, and API Gateway
	// children attached to an API outside it.
	for (const node of root.node.findAll()) {
		if (!cdk.CfnResource.isCfnResource(node)) continue;
		const type = node.cfnResourceType;
		if (isResourcePolicyType(type)) {
			violations.push(...checkResourcePolicy(type, render(node), app.id, node.node.path, parametersOf(cdk.Stack.of(node))));
		} else if (type.startsWith('AWS::ApiGateway')) {
			// A stage, route or deployment on an API outside the app's own template.
			violations.push(...checkApiChild(type, render(node), app.id, node.node.path, parametersOf(cdk.Stack.of(node))));
		}
	}

	// Policies attached to any of those roles (the shared role's DefaultPolicy,
	// helper roles' policies, and any policy the app's code attaches to them).
	for (const [stack, roleIds] of roleIdsByStack) {
		const attached = (value: unknown) =>
			asArray(stack.resolve(value) as unknown[] | undefined).some(
				(r) => !!r && typeof r === 'object' && roleIds.has((r as { Ref?: string }).Ref ?? ''),
			);
		for (const node of stack.node.findAll()) {
			if (cdk.Stack.of(node) !== stack) continue;
			if (!(node instanceof iam.CfnPolicy || node instanceof iam.CfnManagedPolicy)) continue;
			if (!attached(node.roles)) continue;
			const doc = stack.resolve(node.policyDocument) as { Statement?: ResolvedStatement[] } | undefined;
			const parameters = parametersOf(stack);
			for (const statement of asArray(doc?.Statement)) {
				violations.push(...checkStatement(statement, app.id, node.node.path, parameters));
			}
		}
	}
	return violations;
}
