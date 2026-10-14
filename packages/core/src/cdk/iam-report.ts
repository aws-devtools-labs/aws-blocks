// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct, IConstruct } from 'constructs';
import { getRootPermissionsBoundary } from './permissions-boundary.js';

/** One statement on the shared execution role, normalized for diffing. */
interface ReportStatement {
	sid?: string;
	effect: string;
	actions?: string[];
	notActions?: string[];
	resources?: unknown[];
	notResources?: unknown[];
	condition?: unknown;
	/** Logical id of the policy (inline or managed) the statement lives in. */
	policy: string;
	/**
	 * `fullId`s of the Building Blocks that own the resources the statement
	 * references (via `Ref` / `Fn::GetAtt`). Empty when the statement only names
	 * literal ARNs or `*`.
	 */
	blocks: string[];
}

const asArray = <T>(v: T | T[] | undefined): T[] | undefined =>
	v === undefined ? undefined : Array.isArray(v) ? v : [v];
const sortJson = <T>(values: T[]): T[] =>
	[...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** The nearest construct between `node` and `root` (exclusive) that is a Blocks Scope (has a string `fullId`). */
function owningBlock(node: IConstruct, root: Construct): string | undefined {
	for (let current: IConstruct | undefined = node; current && current !== root; current = current.node.scope) {
		const fullId = (current as { fullId?: unknown }).fullId;
		if (typeof fullId === 'string') return fullId;
	}
	return undefined;
}

/** Every logical id referenced by `Ref` / `Fn::GetAtt` anywhere inside `value`. */
function referencedLogicalIds(value: unknown, out = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		for (const v of value) referencedLogicalIds(v, out);
	} else if (value && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		if (typeof obj.Ref === 'string') out.add(obj.Ref);
		const getAtt = obj['Fn::GetAtt'];
		if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') out.add(getAtt[0]);
		for (const v of Object.values(obj)) referencedLogicalIds(v, out);
	}
	return out;
}

/**
 * Build the composed-policy report for `root`'s shared execution role: every
 * statement on every inline/managed policy attached to it, the managed policy
 * ARNs, the boundary AWS Blocks applied, and an inventory of the other roles
 * under `root`. Values are CloudFormation-resolved (`Ref` / `Fn::GetAtt` stay
 * as objects) and sorted, so the output is stable across synths.
 *
 * Must run after aspects and before the template is final — i.e. from a custom
 * synthesis hook (see {@link attachIamReport}).
 */
function buildReport(root: Construct, role: iam.Role) {
	const stack = cdk.Stack.of(role);
	const roleCfn = role.node.defaultChild as iam.CfnRole;
	const roleId = stack.resolve(roleCfn.logicalId) as string;

	const owners = new Map<string, string>();
	const policies: { id: string; document: unknown }[] = [];
	const otherRoles: { logicalId: string; path: string }[] = [];
	const attachedToRole = (roles: unknown) =>
		(asArray(stack.resolve(roles)) ?? []).some((r) => JSON.stringify(r) === JSON.stringify({ Ref: roleId }));

	for (const node of stack.node.findAll()) {
		if (!cdk.CfnElement.isCfnElement(node) || cdk.Stack.of(node) !== stack) continue;
		const logicalId = stack.resolve(node.logicalId) as string;
		const owner = owningBlock(node, root);
		if (owner) owners.set(logicalId, owner);

		if (node instanceof iam.CfnPolicy && attachedToRole(node.roles)) {
			policies.push({ id: logicalId, document: node.policyDocument });
		} else if (node instanceof iam.CfnManagedPolicy && attachedToRole(node.roles)) {
			policies.push({ id: logicalId, document: node.policyDocument });
		} else if (
			cdk.CfnResource.isCfnResource(node) &&
			node.cfnResourceType === 'AWS::IAM::Role' &&
			node !== roleCfn &&
			node.node.path.startsWith(`${root.node.path}/`)
		) {
			otherRoles.push({ logicalId, path: node.node.path });
		}
	}
	for (const inline of asArray(stack.resolve(roleCfn.policies)) ?? []) {
		const { policyName, policyDocument } = inline as { policyName: string; policyDocument: unknown };
		policies.push({ id: `${roleId}.${policyName}`, document: policyDocument });
	}

	const statements: ReportStatement[] = [];
	for (const { id, document } of policies) {
		const resolved = stack.resolve(document) as { Statement?: Record<string, unknown>[] } | undefined;
		for (const s of resolved?.Statement ?? []) {
			const blocks = [...referencedLogicalIds([s.Resource, s.NotResource, s.Condition])]
				.map((lid) => owners.get(lid))
				.filter((b): b is string => b !== undefined);
			const actions = asArray(s.Action as string | string[] | undefined);
			const notActions = asArray(s.NotAction as string | string[] | undefined);
			const resources = asArray(s.Resource);
			const notResources = asArray(s.NotResource);
			statements.push({
				...(s.Sid !== undefined ? { sid: s.Sid as string } : {}),
				effect: s.Effect as string,
				...(actions ? { actions: [...actions].sort() } : {}),
				...(notActions ? { notActions: [...notActions].sort() } : {}),
				...(resources ? { resources: sortJson(resources) } : {}),
				...(notResources ? { notResources: sortJson(notResources) } : {}),
				...(s.Condition !== undefined ? { condition: s.Condition } : {}),
				policy: id,
				blocks: [...new Set(blocks)].sort(),
			});
		}
	}

	const boundary = getRootPermissionsBoundary(root);
	return {
		schemaVersion: 1,
		description:
			'Composed IAM permissions of the AWS Blocks shared execution role, which every Blocks compute ' +
			'(API handler, raw routes, queue/cron/WebSocket handlers, agent runtime) runs as. Generated at synth.',
		root: root.node.path,
		executionRole: {
			logicalId: roleId,
			permissionsBoundary: boundary ? stack.resolve(boundary.managedPolicyArn) : null,
			managedPolicyArns: sortJson(asArray(stack.resolve(roleCfn.managedPolicyArns)) ?? []),
			statements: sortJson(statements),
		},
		otherRoles: [...otherRoles].sort((a, b) => a.path.localeCompare(b.path)),
	};
}

/**
 * Write a synth-time report of the composed IAM policy on `root`'s shared
 * execution role to `<cdk.out>/<fileStem>.blocks-iam.json`.
 *
 * Every Building Block grants onto the one shared role, so the role is the union
 * of every block's permissions; this file makes that union visible and
 * machine-diffable (e.g. a CI step that fails when an app's grants grow beyond an
 * allowed scope). It is CDK-only, writes nothing to the CloudFormation template,
 * and is produced by a custom-synthesis hook on the role — which CDK calls after
 * every aspect has run, so it sees the final policy.
 *
 * @internal
 */
export function attachIamReport(root: Construct, role: iam.Role, fileStem: string): void {
	cdk.attachCustomSynthesis(role, {
		onSynthesize(session) {
			const file = join(session.outdir, `${fileStem}.blocks-iam.json`);
			const report = buildReport(root, role);
			writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
			// One line when synthesized by the CDK CLI (which sets CDK_OUTDIR); quiet in unit tests.
			if (process.env.CDK_OUTDIR) {
				const shown = relative(process.cwd(), file);
				process.stderr.write(
					`[Blocks] IAM report (${report.executionRole.statements.length} statements on the shared execution role): ${shown.startsWith('..') ? file : shown}\n`,
				);
			}
		},
	});
}
