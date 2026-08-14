// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Self-contained CDK provisioning for the Agent BB's AgentCore Runtime.
 *
 * This class owns EVERYTHING AgentCore-specific: the synth-time co-bundle of the app backend,
 * the `Runtime` construct (via `fromCodeAsset` — Node 22 CodeZip, no Docker), its dedicated
 * execution role and that role's IAM grants, the container env injection, and the grant that
 * lets the app's RPC handler invoke the runtime. It is deliberately kept in one place, with
 * no AgentCore details leaking into the `Agent` CDK constructor, so it can later fold into a
 * per-BB compute abstraction (should one land) without touching call sites — the Agent just
 * constructs it and hands over references to the BBs the loop uses.
 *
 * The agent loop runs INSIDE this runtime and streams to the browser via the Realtime BB, so
 * the runtime's role — a SEPARATE principal from the shared Blocks handler role — is granted
 * Realtime publish access (see `realtime.grantPublish`), plus Bedrock, the conversation/message
 * tables, and the session bucket. Inbound auth is IAM (SigV4): the RPC handler invokes with its
 * own credentials; the browser never talks to the runtime directly.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { AgentCoreRuntime as AgentCoreRuntimeVersion, AgentRuntimeArtifact, Runtime } from 'aws-cdk-lib/aws-bedrockagentcore';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { registerConfig, Scope } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import type { Realtime } from '@aws-blocks/bb-realtime';
import { bundleAgentCoreAsset } from './agentcore-bundle.js';

/** References the agent loop needs, handed in by the Agent CDK constructor. */
export interface AgentCoreRuntimeProps {
	/** fullId of the owning Agent — the container looks the Agent up by this (`BB_AGENT_ID`). */
	agentFullId: string;
	/** Realtime BB the loop publishes chunks to. Its `grantPublish` wires the shared role. */
	realtime: InstanceType<typeof Realtime>;
	/**
	 * Pre-built asset dir to use instead of co-bundling at synth. Set by unit tests and apps
	 * that pre-bundle; when omitted, the backend module is co-bundled from the BlocksStack.
	 */
	agentcoreAssetPath?: string;
}

export class AgentCoreRuntime extends Scope {
	/** The provisioned runtime, or undefined when no backend asset could be resolved (isolated tests). */
	readonly runtime?: Runtime;
	/** The runtime ARN (empty string when not provisioned). */
	readonly runtimeArn: string;

	constructor(scope: ScopeParent, id: string, props: AgentCoreRuntimeProps) {
		super(id, { parent: scope });

		const assetPath = props.agentcoreAssetPath ?? this.buildAsset();
		if (!assetPath) {
			// No backend module discoverable (e.g. an isolated unit test that constructs the
			// Agent without a BlocksStack) — skip provisioning rather than failing synth.
			this.runtimeArn = '';
			return;
		}

		const stack = cdk.Stack.of(this);

		// Run the loop AS the shared Blocks execution role (`role: this.executionRole`) — the same
		// role the Lambda handler runs as. Because every Building Block grants its runtime permissions
		// to this role (a tool that uses KVStore/tables/etc. grants there too), the AgentCore
		// container inherits them all automatically — no bespoke, under-granted role, and no need to
		// mirror each BB's grants. BlocksRole trusts `bedrock-agentcore` so the runtime can assume it
		// (see core/cdk/blocks-backend.ts). One shared role that any compute can assume keeps this a
		// drop-in for a future per-BB compute abstraction.
		const role = this.executionRole;

		// Add the agent's shared-role grants ONCE per stack. Every agent instance would otherwise add
		// the SAME Bedrock / InvokeAgentRuntime / Realtime-publish statements to the ONE shared role;
		// with several agents in an app that piles up duplicates and overflows the IAM inline-policy
		// size limit (CDK then spills into `OverflowPolicy` managed policies and the role misbehaves).
		// These grants are identical for every agent — the Realtime infra, Bedrock models, and the
		// runtime-ARN wildcard are all stack-scoped — so granting once covers every agent's container.
		// (The session bucket + conversation/message tables are already granted to the shared role by
		// the Agent's FileBucket/DistributedTable children, so they're not repeated here.)
		const SHARED_GRANTS_KEY = Symbol.for('BLOCKS_AGENT_RUNTIME_SHARED_ROLE_GRANTS');
		const stackAny = stack as unknown as Record<symbol, { callbackUrl: string } | undefined>;
		let sharedGrants = stackAny[SHARED_GRANTS_KEY];
		if (!sharedGrants) {
			// Realtime publish (postToConnection + connections-table query) + the config to inject.
			const { callbackUrl } = props.realtime.grantPublish(role);
			// Bedrock model access for the loop (no Building Block grants this, and the loop no longer
			// runs on the handler).
			role.addToPrincipalPolicy(
				new PolicyStatement({
					actions: [
						'bedrock:InvokeModel',
						'bedrock:InvokeModelWithResponseStream',
						'bedrock:GetFoundationModel',
						'bedrock:ListFoundationModels',
						'bedrock:GetInferenceProfile',
					],
					resources: [`arn:${stack.partition}:bedrock:*::foundation-model/*`, `arn:${stack.partition}:bedrock:*:*:inference-profile/*`],
				}),
			);
			// Let the app's RPC handler (also the shared role) invoke the runtimes — stream()/resume()
			// call InvokeAgentRuntime. Scope to a wildcard runtime ARN rather than a specific runtime's
			// ARN: the runtime uses this same shared role as its executionRole, so referencing its ARN
			// here would create a Role→Runtime→Role dependency cycle. (Same wildcard style as Bedrock.)
			role.addToPrincipalPolicy(
				new PolicyStatement({
					actions: ['bedrock-agentcore:InvokeAgentRuntime'],
					resources: [
						`arn:${stack.partition}:bedrock-agentcore:${stack.region}:${stack.account}:runtime/*`,
						`arn:${stack.partition}:bedrock-agentcore:${stack.region}:${stack.account}:runtime/*/*`,
					],
				}),
			);
			sharedGrants = { callbackUrl };
			stackAny[SHARED_GRANTS_KEY] = sharedGrants;
		}
		// Same for every agent in the stack (shared Realtime infra → one callback URL).
		const callbackUrl = sharedGrants.callbackUrl;

		const runtime = new Runtime(this, 'AgentRuntime', {
			agentRuntimeArtifact: AgentRuntimeArtifact.fromCodeAsset({
				path: assetPath,
				runtime: AgentCoreRuntimeVersion.NODE_22,
				// Launch command, NOT a Lambda file.export handler. Single element = the .js file;
				// the NODE_22 runtime invokes `node` itself. (A leading 'node' element is rejected.)
				entrypoint: ['main.js'],
			}),
			executionRole: role,
			// Inbound auth defaults to IAM (SigV4): the RPC handler invokes with its own creds.
			// The browser never invokes the runtime directly (it subscribes to Realtime).
			environmentVariables: {
				// The Agent's fullId so the container's getAgentInstance(BB_AGENT_ID) matches the
				// Agent the co-bundled backend registers at import.
				BB_AGENT_ID: props.agentFullId,
				// The runtime Scope derives fullId by walking to a parent whose id is
				// BLOCKS_STACK_NAME (same as the Lambda handler); without it the backend registers
				// under an un-prefixed fullId that won't match BB_AGENT_ID.
				BLOCKS_STACK_NAME: stack.stackName,
				// The Realtime publish endpoint — publish() reads this from process.env. Outside the
				// Blocks handler it isn't otherwise discoverable, so grantPublish hands it back.
				BLOCKS_RT_CALLBACK_URL: callbackUrl,
			},
		});
		this.runtime = runtime;
		this.runtimeArn = runtime.agentRuntimeArn;

		// Expose THIS agent's runtime ARN to the Lambda runtime path so stream() can resolve it at
		// call time. Per-agent (each agent has its own runtime), so it stays outside the shared guard.
		registerConfig(this, `BB_AGENT_${props.agentFullId}_RUNTIME_ARN`, runtime.agentRuntimeArn);
	}

	/**
	 * Co-bundle the app backend + `serve()` into an AgentCore code-asset dir. Returns undefined
	 * when the backend module path can't be discovered (isolated unit tests) — the caller then
	 * skips provisioning rather than failing synth.
	 */
	private buildAsset(): string | undefined {
		const stack = (globalThis as any).CURRENT_BLOCKS_STACK as { backendModulePath?: string } | undefined;
		const backendModulePath = stack?.backendModulePath;
		if (!backendModulePath) return undefined;
		const outDir = join(
			cdk.App.of(this)?.outdir ?? cdk.Stack.of(this).node.tryGetContext('cdk.out') ?? '.cdk-agentcore',
			`agentcore-${this.fullId}`,
		);
		mkdirSync(outDir, { recursive: true });
		return bundleAgentCoreAsset(backendModulePath, outDir);
	}
}
