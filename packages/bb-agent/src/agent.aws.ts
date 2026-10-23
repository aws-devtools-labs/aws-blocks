// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { getConfig, installClientUserAgent } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import type { FileBucket } from '@aws-blocks/bb-file-bucket';
import type { ChildLogger } from '@aws-blocks/bb-logger';
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
 * microVM across turns/resumes. Only conversation ids are passed to it: a turn without a
 * conversation is hashed from its user and channel instead (see {@link runtimeSessionIdFor}).
 */
function toRuntimeSessionId(base: string): string {
	return base.length >= 33 ? base : createHash('sha256').update(base).digest('hex');
}

/**
 * The AgentCore session for a turn. A conversation routes to its own session (its id). A turn
 * without a conversation gets a session derived from its user and channel instead of the bare
 * channelId: the channelId is caller-chosen, so it could otherwise equal another user's
 * conversation id and land the turn in that user's session.
 */
function runtimeSessionIdFor(payload: { conversationId?: string; channelId: string; userId: string }): string {
	if (payload.conversationId) return toRuntimeSessionId(payload.conversationId);
	// JSON keeps the (userId, channelId) pair unambiguous and, unlike encodeURIComponent, never throws.
	return createHash('sha256').update(`turn:${JSON.stringify([payload.userId, payload.channelId])}`).digest('hex');
}

/**
 * Builds the deployed Agent's snapshot storage, pinning S3Storage to the Lambda
 * execution region (`AWS_REGION`) so non-us-east-1 deploys use the correct regional
 * endpoint (#120). `S3StorageImpl` is injectable so tests can assert the resulting
 * config without depending on S3Storage/AWS SDK internals; production uses the real one.
 *
 * The read paths are delegated to S3Storage UNCHANGED: a genuinely missing object
 * (the first-turn case) already comes back as `NoSuchKey`/`NoSuchBucket` → `null`
 * from S3Storage itself, which Strands' `SessionManager` treats as "start fresh".
 * A read that fails for any OTHER reason — `AccessDenied`, a 5xx, a corrupt object —
 * means the snapshot may exist and simply was not read, so it rethrows and surfaces
 * rather than silently overwriting an established conversation's saved history with a
 * blank one. (An earlier revision swallowed every read error here; a sandbox deploy
 * and a local Strands reproduction showed that turns a crash-on-fault into silent
 * loss of state, because `SessionManager` overwrites `snapshot_latest.json` after a
 * fresh start — so a transient 503 on turn N would erase turns 1..N-1. Reverted.)
 *
 * The diagnostic value is kept where it belongs: a rethrown restore error propagates
 * into `runAgent`'s catch, which logs the deepest cause's `name`, `httpStatusCode`
 * and `requestId` (flattened out of the non-enumerable `.cause`) at `error` level —
 * so the concrete production error shape is still captured, without the data-loss
 * fallback. `log` is threaded in from the agent for that seam.
 */
export function createDeployedSnapshotStorage(
	bucket: FileBucket,
	// Threaded from the agent so the storage layer has the agent's structured logger
	// available; the concrete read-error shape is logged by runAgent's catch when a
	// restore error propagates (see errorCauseShape in agent.ts), not here.
	_log: ChildLogger,
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
	 * warm microVM; a turn without a conversation gets its own session (see runtimeSessionIdFor).
	 *
	 * @internal Internal compute seam; not customer API.
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
		if (!this._agentCore) {
			this._agentCore = new BedrockAgentCoreClient({
				customUserAgent: this.buildUserAgentChain(),
			});
			installClientUserAgent(this._agentCore);
		}
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
				runtimeSessionId: runtimeSessionIdFor(payload),
				contentType: 'application/json',
				accept: 'application/json',
				payload: new TextEncoder().encode(JSON.stringify(body)),
			}),
		);
	}
}
