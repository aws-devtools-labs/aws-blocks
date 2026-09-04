// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import { DistributedTable } from '@aws-blocks/bb-distributed-table';
import { Realtime } from '@aws-blocks/bb-realtime';
import { FileBucket } from '@aws-blocks/bb-file-bucket';
import { AgentCoreRuntime } from './agentcore-runtime.cdk.js';
import { messageSchema, conversationSchema, agentStreamChunkSchema } from './schemas.js';
import type { AgentConfig } from './types.js';

export { AgentErrors } from './errors.js';
export { BedrockModels, OllamaModels } from './models.js';

export class Agent extends Scope {
	/**
	 * CDK layer for the Agent BB.
	 *
	 * Provisions the session FileBucket, the conversation + message DistributedTables, the
	 * Realtime BB used to stream chunks to the browser, and the AgentCore Runtime that hosts
	 * the streaming agent loop. All AgentCore-specific provisioning (co-bundle, runtime role
	 * and its grants, container env, and the handler's invoke permission) lives in the
	 * self-contained {@link AgentCoreRuntime} so it can later fold into a per-BB compute abstraction.
	 *
	 * The loop runs inside the AgentCore Runtime (not the shared handler Lambda), so the shared
	 * handler no longer needs Bedrock access — the runtime's own role gets it (see AgentCoreRuntime).
	 */
	constructor(scope: ScopeParent, id: string, config?: AgentConfig) {
		super(id, { parent: scope });

		// Session-snapshot bucket. Provisioned here (and granted to the shared execution role that the
		// AgentCore Runtime runs as); the deployed loop re-derives its name from this bucket's `fullId`
		// in-process — the same `'sn'` id → same fullId → same physical bucket — so no name needs to be
		// injected into the container. Propagate `removalPolicy` so customers can opt sandbox stacks into
		// clean teardown (without it, CDK's RETAIN default applies). ID shortened to keep the S3 bucket
		// name within the 63-char limit.
		new FileBucket(this, 'sn', { removalPolicy: config?.removalPolicy });

		// Conversation metadata + message history. These grant read/write to the shared execution
		// role, which the AgentCore Runtime then runs as — so the loop can persist history.
		if (!config?.inferenceOnly) {
			new DistributedTable(this, 'convos', {
				schema: conversationSchema,
				key: { partitionKey: 'userId', sortKey: 'conversationId' },
			});
			new DistributedTable(this, 'messages', {
				schema: messageSchema,
				key: { partitionKey: 'conversationId', sortKey: 'messageId' },
			});
		}

		new Realtime(this, 'rt', {
			namespaces: {
				chunks: Realtime.namespace(agentStreamChunkSchema),
			},
		});

		// The agent loop runs on the AgentCore Runtime (as the shared Blocks execution role) and
		// streams to the browser over Realtime. AgentCoreRuntime co-bundles the app backend,
		// provisions the runtime, adds the bedrock-agentcore trust + Bedrock to the shared role, and
		// injects the config location so the container loads the same app config as the handler
		// (the session bucket/tables and Realtime publish are already granted to that role). Kept
		// self-contained so it can later fold into a per-BB compute abstraction.
		new AgentCoreRuntime(this, 'runtime', {
			agentFullId: this.fullId,
			agentcoreAssetPath: config?.agentcoreAssetPath,
		});
	}
}
