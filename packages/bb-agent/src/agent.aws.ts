// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { getConfig } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import type { FileBucket } from '@aws-blocks/bb-file-bucket';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { SnapshotStorage } from '@strands-agents/sdk';
import { S3Storage } from '@strands-agents/sdk/session/s3-storage';
import type { S3StorageConfig } from '@strands-agents/sdk/session/s3-storage';
import { AgentBase, type AgentTurnPayload } from './agent.js';
import { AgentErrors, blocksAgentError } from './errors.js';
import type { AgentConfig, DefaultToolContext } from './types.js';
import { BedrockModels } from './models.js';

/**
 * AgentCore requires a `runtimeSessionId` of at least 33 characters. Conversation/channel ids
 * are UUIDs (36 chars) in the normal path and pass through unchanged; anything shorter is hashed
 * to a stable 64-char hex id — stable per input, so a conversation keeps routing to one warm
 * microVM across turns/resumes.
 */
function toRuntimeSessionId(base: string): string {
	return base.length >= 33 ? base : createHash('sha256').update(base).digest('hex');
}

/**
 * Builds the deployed Agent's snapshot storage, pinning S3Storage to the Lambda
 * execution region (`AWS_REGION`) so non-us-east-1 deploys use the correct regional
 * endpoint (#120). `S3StorageImpl` is injectable so tests can assert the resulting
 * config without depending on S3Storage/AWS SDK internals; production uses the real one.
 */
export function createDeployedSnapshotStorage(
	bucket: FileBucket,
	S3StorageImpl: new (config: S3StorageConfig) => SnapshotStorage = S3Storage,
): SnapshotStorage {
	return new S3StorageImpl({ bucket: bucket.fullId, region: process.env.AWS_REGION });
}

export class Agent<TContext = DefaultToolContext> extends AgentBase<TContext> {
	private _agentCore?: BedrockAgentCoreClient;

	constructor(scope: ScopeParent, id: string, config: AgentConfig<TContext>) {
		super(scope, id, config, config.model?.deployed ?? BedrockModels.BALANCED, createDeployedSnapshotStorage);
	}

	/**
	 * Run the turn on the AgentCore Runtime that hosts this agent's loop.
	 *
	 * Returns as soon as the runtime has ACCEPTED the turn: `agentcore-entry` starts `runAgent()`
	 * as a background async task (which streams chunks to Realtime under the runtime's own role)
	 * and responds immediately, so this `InvokeAgentRuntime` call does NOT hold the connection for
	 * the turn's duration — the loop keeps running server-side for up to the 8h session lifetime.
	 * `runtimeSessionId` is keyed by conversationId so a conversation's turns/resumes reuse one
	 * warm microVM.
	 */
	protected override async dispatchTurn(payload: AgentTurnPayload<TContext>): Promise<void> {
		const runtimeArnKey = `BB_AGENT_${this.fullId}_RUNTIME_ARN`;
		const runtimeArn = await getConfig(runtimeArnKey);
		if (!runtimeArn) {
			throw blocksAgentError(
				AgentErrors.StreamFailed,
				`AgentCore Runtime ARN not found (config key ${runtimeArnKey}). Ensure the app build produced the AgentCore asset and the stack deployed the Runtime.`,
			);
		}
		this._agentCore ??= new BedrockAgentCoreClient({});
		const body = {
			prompt: payload.message,
			channelId: payload.channelId,
			conversationId: payload.conversationId,
			userId: payload.userId,
			interruptResponses: payload.interruptResponses,
			context: payload.context,
		};
		await this._agentCore.send(
			new InvokeAgentRuntimeCommand({
				agentRuntimeArn: runtimeArn,
				runtimeSessionId: toRuntimeSessionId(payload.conversationId ?? payload.channelId),
				contentType: 'application/json',
				accept: 'application/json',
				payload: new TextEncoder().encode(JSON.stringify(body)),
			}),
		);
	}
}
