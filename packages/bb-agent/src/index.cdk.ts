// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DistributedTable } from '@aws-blocks/bb-distributed-table';
import { FileBucket } from '@aws-blocks/bb-file-bucket';
import type { ScopeParent } from '@aws-blocks/core';
import { registerConfig, Scope } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import {
	AgentCoreRuntime,
	AgentRuntimeArtifact,
	Runtime,
	RuntimeAuthorizerConfiguration,
} from 'aws-cdk-lib/aws-bedrockagentcore';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { bundleAgentCoreAsset } from './agentcore-bundle.js';
import { conversationSchema, messageSchema } from './schemas.js';

export { AgentErrors } from './errors.js';
export { BedrockModels, OllamaModels } from './models.js';

export class Agent extends Scope {
	/**
	 * CDK layer for the Agent BB. Provisions the session FileBucket, the conversation +
	 * message DistributedTables, and the AgentCore Runtime that hosts the streaming agent
	 * loop (replacing the former Lambda + SQS + AppSync/Realtime side-channel).
	 *
	 * TODO: scope Bedrock IAM grant to specific modelId from config
	 * TODO: guardrails CDK provisioning
	 */
	constructor(scope: ScopeParent, id: string, config?: any) {
		super(id, { parent: scope });

		this.handler.addToRolePolicy(
			new PolicyStatement({
				actions: [
					'bedrock:InvokeModel',
					'bedrock:InvokeModelWithResponseStream',
					'bedrock:GetFoundationModel',
					'bedrock:ListFoundationModels',
					'bedrock:GetInferenceProfile',
				],
				resources: ['arn:aws:bedrock:*::foundation-model/*', 'arn:aws:bedrock:*:*:inference-profile/*'],
			}),
		);

		// Propagate `removalPolicy` to the sessions bucket so customers can
		// opt sandbox stacks into clean teardown. Without it, CDK's RETAIN
		// default applies (production-safe) and `cdk destroy` will fail on
		// a non-empty bucket — same pattern as FileBucket / KnowledgeBase.
		// ID shortened to keep S3 bucket names within the 63-char limit
		const sessionBucket = new FileBucket(this, 'sn', { removalPolicy: config?.removalPolicy });

		let conversationsTable: DistributedTable<any> | undefined;
		let messagesTable: DistributedTable<any> | undefined;
		if (!config?.inferenceOnly) {
			conversationsTable = new DistributedTable(this, 'convos', {
				schema: conversationSchema,
				key: { partitionKey: 'userId', sortKey: 'conversationId' },
			});
			messagesTable = new DistributedTable(this, 'messages', {
				schema: messageSchema,
				key: { partitionKey: 'conversationId', sortKey: 'messageId' },
			});
		}

		// ── AgentCore Runtime (SSE streaming) ────────────────────────────────
		// Provision the AgentCore Runtime that hosts the Strands loop, replacing the
		// Lambda+SQS+AppSync streaming path. The code asset is co-bundled at synth time:
		// the developer backend + bb-agent's `serve()` in a single esbuild graph, so the
		// Agent instance registry (a module singleton) is shared (see agentcore-bundle.ts).
		//
		// `config.agentcoreAssetPath` (a pre-built dir) still takes precedence when provided
		// — used by unit tests and by apps that pre-bundle. Otherwise we co-bundle from the
		// app's backend module path, discovered off the BlocksStack.
		const assetPath = config?.agentcoreAssetPath ?? this.buildAgentCoreAsset();
		if (assetPath) {
			const runtime = new Runtime(this, 'AgentRuntime', {
				agentRuntimeArtifact: AgentRuntimeArtifact.fromCodeAsset({
					path: assetPath,
					runtime: AgentCoreRuntime.NODE_22,
					// Launch command, NOT a Lambda file.export handler.
					// Single element = the .js file; the NODE_22 runtime invokes `node` itself.
					// (A leading 'node' element makes AgentCore reject the entrypoint.)
					entrypoint: ['main.js'],
				}),
				environmentVariables: {
					BB_AGENT_ID: this.fullId,
					BB_AGENT_SESSION_BUCKET: sessionBucket.fullId,
					// The runtime Scope derives fullId by walking to a parent whose id is
					// BLOCKS_STACK_NAME (same as the Lambda handler). Without it, the agent
					// registers under an un-prefixed fullId (e.g. `test-app-agent`) that won't
					// match BB_AGENT_ID (`<stack>-test-app-agent`) → "No Agent registered".
					BLOCKS_STACK_NAME: cdk.Stack.of(this).stackName,
				},
				// Inbound auth: JWT from the app's auth BB, else IAM (SigV4) by default.
				authorizerConfiguration: resolveAuthorizer(config?.auth),
			});

			// The runtime's execution role needs the same Bedrock access the Lambda has,
			// plus read/write to the session bucket and (for history persistence) the tables.
			runtime.role.addToPrincipalPolicy(
				new PolicyStatement({
					actions: [
						'bedrock:InvokeModel',
						'bedrock:InvokeModelWithResponseStream',
						'bedrock:GetFoundationModel',
						'bedrock:ListFoundationModels',
						'bedrock:GetInferenceProfile',
					],
					resources: ['arn:aws:bedrock:*::foundation-model/*', 'arn:aws:bedrock:*:*:inference-profile/*'],
				}),
			);

			// Session snapshots (S3Storage) → read/write the session FileBucket. Its physical
			// name is the bucket's fullId (see FileBucket runtime), so scope to that.
			const stack = cdk.Stack.of(this);
			runtime.role.addToPrincipalPolicy(
				new PolicyStatement({
					actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
					resources: [`arn:aws:s3:::${sessionBucket.fullId}`, `arn:aws:s3:::${sessionBucket.fullId}/*`],
				}),
			);

			// Conversation history persistence (DistributedTable) → read/write the two tables.
			// Table names are the tables' fullIds; include index ARNs for query support.
			const tableArns: string[] = [];
			for (const t of [conversationsTable, messagesTable]) {
				if (!t) continue;
				const base = `arn:aws:dynamodb:${stack.region}:${stack.account}:table/${t.fullId}`;
				tableArns.push(base, `${base}/index/*`);
			}
			if (tableArns.length) {
				runtime.role.addToPrincipalPolicy(
					new PolicyStatement({
						actions: [
							'dynamodb:GetItem',
							'dynamodb:PutItem',
							'dynamodb:DeleteItem',
							'dynamodb:Query',
							'dynamodb:BatchGetItem',
							'dynamodb:BatchWriteItem',
						],
						resources: tableArns,
					}),
				);
			}

			// Expose the runtime ARN so the Lambda runtime path can return it from stream()
			// and the client can open the SSE connection directly.
			registerConfig(this, `BB_AGENT_${this.fullId}_RUNTIME_ARN`, runtime.agentRuntimeArn);
		}
	}

	/**
	 * Co-bundle the app backend + bb-agent `serve()` into an AgentCore code-asset dir.
	 *
	 * Returns undefined when the backend module path can't be discovered (e.g. isolated
	 * unit tests that construct the Agent without a BlocksStack) — the caller then skips
	 * provisioning the Runtime rather than failing synth.
	 */
	private buildAgentCoreAsset(): string | undefined {
		const stack = (globalThis as any).CURRENT_BLOCKS_STACK as { backendModulePath?: string } | undefined;
		const backendModulePath = stack?.backendModulePath;
		if (!backendModulePath) return undefined;
		// Write into a stable, synth-scoped dir under cdk.out so the asset staging is
		// deterministic across synths with identical inputs.
		const outDir = join(
			cdk.App.of(this)?.outdir ?? cdk.Stack.of(this).node.tryGetContext('cdk.out') ?? '.cdk-agentcore',
			`agentcore-${this.fullId}`,
		);
		mkdirSync(outDir, { recursive: true });
		return bundleAgentCoreAsset(backendModulePath, outDir);
	}
}

/**
 * Map the developer's auth BB (if any) to an AgentCore inbound authorizer. Cognito and
 * OIDC both issue standard JWTs validated on the streaming endpoint; with no auth BB the
 * Runtime defaults to IAM (SigV4). AuthBasic is unsupported on AgentCore streaming (design
 * doc Q2) — falls through to IAM here.
 */
function resolveAuthorizer(auth: any): RuntimeAuthorizerConfiguration | undefined {
	if (!auth) return undefined; // Runtime default is IAM.
	if (auth.userPool && auth.userPoolClient) {
		return RuntimeAuthorizerConfiguration.usingCognito(auth.userPool, [auth.userPoolClient]);
	}
	if (auth.oidcDiscoveryUrl) {
		return RuntimeAuthorizerConfiguration.usingJWT(
			auth.oidcDiscoveryUrl,
			auth.clientId ? [auth.clientId] : undefined,
		);
	}
	return undefined;
}
