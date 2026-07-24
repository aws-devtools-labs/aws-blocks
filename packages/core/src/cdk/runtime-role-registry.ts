// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

const REGISTRY_KEY = Symbol.for('BLOCKS_AGENT_RUNTIME_ROLES');

interface RuntimeRoleRegistryState {
	roles: iam.IRole[];
	finalized: boolean;
}

/**
 * Get or create the AgentCore-runtime-role registry for a given stack.
 * Collects the execution roles of every Agent BB's AgentCore Runtime so their
 * IAM can be reconciled with the shared Lambda handler role at synth time.
 */
function getRegistry(stack: cdk.Stack): RuntimeRoleRegistryState {
	let state = (stack as any)[REGISTRY_KEY] as RuntimeRoleRegistryState | undefined;
	if (!state) {
		state = { roles: [], finalized: false };
		(stack as any)[REGISTRY_KEY] = state;
	}
	return state;
}

/**
 * Register an AgentCore Runtime execution role so it inherits the shared Lambda
 * handler role's permissions at synth finalize time (see `finalizeAgentRuntimeRoles`).
 *
 * Why: the agent loop runs inside the AgentCore container, so its tool handlers call
 * other Building Blocks (KVStore, DistributedTable, FileBucket, …) from THIS role — a
 * different principal than the Lambda `handler` that every BB grants via
 * `grant*Data(this.handler)`. Without reconciliation the container gets AccessDenied on
 * any BB beyond the Agent's own resources.
 *
 * @param scope - The CDK construct (used to find the parent stack)
 * @param role - The AgentCore Runtime execution role to augment
 */
export function registerAgentRuntimeRole(scope: Construct, role: iam.IRole): void {
	const stack = cdk.Stack.of(scope);
	getRegistry(stack).roles.push(role);
}

/**
 * Finalize AgentCore runtime roles: copy the shared Lambda handler role's accumulated
 * permissions onto every registered runtime role, so a tool handler running in the
 * container has the same Building Block access it would have in the Lambda.
 *
 * Must be called AFTER all BBs are constructed (i.e., after the backendCDKPath import
 * completes in BlocksStack.create() / BlocksBackend.create()) — that's when the handler
 * role's default policy has accumulated every BB's grant. Construction order of
 * `new Agent()` vs `new KVStore()` is arbitrary, so this can't happen in the Agent
 * constructor.
 *
 * Copies the handler's default-policy statements. This mirrors "the runtime has the same
 * capability as the handler"; it is intentionally broad. Scoping the copy to only the BBs
 * a given agent's tools touch is future work (needs per-agent grant declaration).
 *
 * @param scope - The CDK construct to resolve the stack from
 * @param handler - The shared Lambda function whose role's grants converge all BB permissions
 */
export function finalizeAgentRuntimeRoles(
	scope: Construct,
	handler: cdk.aws_lambda.IFunction,
): void {
	const stack = cdk.Stack.of(scope);
	const registry = getRegistry(stack);

	if (registry.finalized) return;
	registry.finalized = true;

	if (registry.roles.length === 0) return;

	const handlerRole = handler.role;
	if (!handlerRole) return;

	// All BB grants (grant*Data / addToRolePolicy) land on the handler role's
	// auto-created DefaultPolicy. `PolicyDocument.statements` is private, so read the
	// public JSON shape (`.Statement`) and clone each statement onto the runtime roles.
	const defaultPolicy = handlerRole.node.tryFindChild('DefaultPolicy') as iam.Policy | undefined;
	if (!defaultPolicy) return;
	const doc = defaultPolicy.document.toJSON() as { Statement?: Array<Record<string, unknown>> } | undefined;
	const statements = doc?.Statement ?? [];
	if (statements.length === 0) return;

	for (const role of registry.roles) {
		for (const statement of statements) {
			role.addToPrincipalPolicy(iam.PolicyStatement.fromJson(statement));
		}
	}
}
