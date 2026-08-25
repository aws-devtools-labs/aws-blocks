// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Self-contained CDK provisioning for the Agent BB's AgentCore Runtime.
 *
 * This class owns EVERYTHING AgentCore-specific: the synth-time co-bundle of the app backend,
 * the `Runtime` construct (via `fromCodeAsset` — Node 22 CodeZip, no Docker), the shared role's
 * AgentCore trust + grants, the container env injection, and the grant that lets the app's RPC
 * handler invoke the runtime. It is deliberately kept in one place, with no AgentCore details
 * leaking into the `Agent` CDK constructor or into core, so it can later fold into a per-BB
 * compute abstraction (should one land) without touching call sites — the Agent just constructs
 * it and hands over references to the BBs the loop uses.
 *
 * The loop runs INSIDE this runtime AS the shared Blocks execution role (the same role the Lambda
 * handler runs as), so it inherits every Building Block's grants — including the Realtime publish
 * permissions already granted to the handler, so it streams chunks to the browser via the Realtime
 * BB with no extra grant. The container loads the full app config (via the injected config-bucket
 * location) exactly as the handler does, so it discovers the Realtime callback URL and every other
 * registerConfig() value a tool's BB may need. This class adds to that shared role only what's
 * AgentCore-specific: the `bedrock-agentcore` assume-role trust, Bedrock model access, and the
 * handler's `InvokeAgentRuntime` permission. Inbound auth is IAM (SigV4): the RPC handler
 * invokes with its own credentials; the browser never talks to the runtime directly.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { AgentCoreRuntime as AgentCoreRuntimeVersion, AgentRuntimeArtifact, Runtime } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { getConfigLocation, registerConfig, Scope } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import { bundleAgentCoreAsset } from './agentcore-bundle.js';

/** References the agent loop needs, handed in by the Agent CDK constructor. */
export interface AgentCoreRuntimeProps {
	/** fullId of the owning Agent — the container looks the Agent up by this (`BB_AGENT_ID`). */
	agentFullId: string;
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
		// mirror each BB's grants. One shared role that any compute can assume keeps this a drop-in
		// for a future per-BB compute abstraction.
		const role = this.executionRole;

		// Add the agent's shared-role trust + grants ONCE per stack. Every agent instance would
		// otherwise add the SAME trust / Bedrock / InvokeAgentRuntime statements to the ONE shared
		// role; with several agents in an app that piles up duplicates and overflows the IAM inline-
		// policy size limit (CDK then spills into `OverflowPolicy` managed policies and the role
		// misbehaves). These are identical for every agent — Bedrock models and the runtime-ARN
		// wildcard are stack-scoped — so doing it once covers every agent's container. (Realtime
		// publish, the session bucket, and the conversation/message tables are already granted to the
		// shared role by the Realtime BB's handler wiring and the Agent's FileBucket/DistributedTable
		// children, so they're not repeated here — the loop inherits them by running as the role.)
		const SHARED_GRANTS_KEY = Symbol.for('BLOCKS_AGENT_RUNTIME_SHARED_ROLE_GRANTS');
		const stackAny = stack as unknown as Record<symbol, boolean | undefined>;
		if (!stackAny[SHARED_GRANTS_KEY]) {
			// The container publishes to Realtime AS this shared role, which already holds the publish
			// grants (the Realtime BB grants postToConnection + the connections table to the handler on
			// the same role) — so no Realtime IAM grant is needed here; it's inherited by running as the role.

			// Trust: let the AgentCore Runtime assume this shared role (it runs AS the role). Added here
			// rather than in core, so the role only trusts `bedrock-agentcore` when an Agent exists.
			// Scope it to this account/region with aws:SourceAccount + aws:SourceArn — AWS's recommended
			// AgentCore Runtime trust policy — so only AgentCore runtimes in THIS account can assume the
			// role (tightens the confused-deputy surface) without breaking assumption. `assumeRolePolicy`
			// exists only on the concrete `Role`; core always creates BlocksRole concretely, so narrow
			// and fail loud if that ever changes.
			if (!(role instanceof Role)) {
				throw new Error(
					'AgentCore Runtime requires the shared Blocks execution role to be a concrete iam.Role to add its assume-role trust',
				);
			}
			role.assumeRolePolicy?.addStatements(
				new PolicyStatement({
					effect: Effect.ALLOW,
					principals: [new ServicePrincipal('bedrock-agentcore.amazonaws.com')],
					actions: ['sts:AssumeRole'],
					conditions: {
						StringEquals: { 'aws:SourceAccount': stack.account },
						ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:bedrock-agentcore:${stack.region}:${stack.account}:*` },
					},
				}),
			);
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
			stackAny[SHARED_GRANTS_KEY] = true;
		}

		// Inject the config location so the container loads the FULL app config via
		// loadConfigToProcessEnv() — the same config the Lambda handler loads. That's how it gets
		// BLOCKS_RT_CALLBACK_URL (registered by the Realtime BB) plus any other config-backed BB value
		// an agent's tools touch; without it the container runs with empty config and those BBs fail.
		// Idempotent (one config bucket per stack); IAM to read it is inherited via the shared role.
		const { bucketName: configBucketName, key: configKey } = getConfigLocation(this);

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
				// Config location so the container's loadConfigToProcessEnv() loads the full app config
				// (same as the handler) — this delivers BLOCKS_RT_CALLBACK_URL and every other
				// registerConfig() value a tool's BB may read. IAM to read it is inherited (shared role).
				BLOCKS_CONFIG_BUCKET: configBucketName,
				BLOCKS_CONFIG_KEY: configKey,
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
