// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct, IConstruct } from 'constructs';
import { finalizeBlocksRoles } from './blocks-roles.js';

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

/** One IAM role AWS Blocks created for the root, with its boundary and tags as rendered for the template. */
interface ReportRole {
	logicalId: string;
	/** Cloud-assembly artifact id of the stack the role is in (helper stacks, e.g. us-east-1, appear separately). */
	stack: string;
	path: string;
	/** `PermissionsBoundary` exactly as the template carries it, or `null` when the role has none. */
	permissionsBoundary: unknown;
	/** `Tags` exactly as the template carries them (empty when the role has none). */
	tags: unknown[];
}

/**
 * A role's CloudFormation `Properties` as they will be written to the template —
 * property overrides (the boundary aspect, CDK's boundary context, escape hatches)
 * and aspect-applied tags included — resolved to CloudFormation intrinsics.
 *
 * CDK exposes this rendering only through `CfnElement._toCloudFormation()`, which
 * its stack synthesizer calls; there's no public equivalent. The IAM report's
 * tests compare these values against the synthesized template, so a CDK change
 * that alters this method fails CI rather than skewing the report.
 */
function renderedProperties(role: cdk.CfnResource): Record<string, unknown> {
	const rendered = (role as unknown as { _toCloudFormation(): unknown })._toCloudFormation();
	// The entry is a post-resolve token (that's where overrides are merged in), so
	// resolve the whole rendering before reading it.
	const resolved = cdk.Stack.of(role).resolve(rendered) as {
		Resources?: Record<string, { Properties?: Record<string, unknown> }>;
	};
	return Object.values(resolved.Resources ?? {})[0]?.Properties ?? {};
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
 * ARNs and the boundary as the template carries them, and an inventory of every
 * role AWS Blocks created for `root` (each with its boundary and tags as
 * rendered), so a pipeline can verify both from this one file. Values are CloudFormation-resolved (`Ref` / `Fn::GetAtt` stay
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

	// Every role AWS Blocks created for this root — the same set the permissions
	// boundary is applied to (blocks-roles.ts), including other stacks' roles.
	const roles: ReportRole[] = finalizeBlocksRoles(root).map((r) => {
		const props = renderedProperties(r);
		const roleStack = cdk.Stack.of(r);
		return {
			logicalId: roleStack.resolve(r.logicalId) as string,
			stack: roleStack.artifactId,
			path: r.node.path,
			permissionsBoundary: props.PermissionsBoundary ?? null,
			tags: asArray(props.Tags as unknown[] | undefined) ?? [],
		};
	});
	const executionRoleProps = renderedProperties(roleCfn);
	return {
		schemaVersion: 1,
		description:
			'Composed IAM permissions of the AWS Blocks shared execution role, which every Blocks compute ' +
			'(API handler, raw routes, queue/cron/WebSocket handlers, agent runtime) runs as. Generated at synth.',
		root: root.node.path,
		executionRole: {
			logicalId: roleId,
			permissionsBoundary: executionRoleProps.PermissionsBoundary ?? null,
			managedPolicyArns: sortJson(asArray(stack.resolve(roleCfn.managedPolicyArns)) ?? []),
			statements: sortJson(statements),
		},
		roles: roles.sort((a, b) => a.stack.localeCompare(b.stack) || a.logicalId.localeCompare(b.logicalId)),
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
