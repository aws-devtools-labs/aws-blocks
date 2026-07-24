// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { FileBucket } from '@aws-blocks/bb-file-bucket';
import type { ScopeParent } from '@aws-blocks/core';
import { getConfig } from '@aws-blocks/core';
import type { SnapshotStorage } from '@strands-agents/sdk';
import type { S3StorageConfig } from '@strands-agents/sdk/session/s3-storage';
import { S3Storage } from '@strands-agents/sdk/session/s3-storage';
import { AgentBase } from './agent.js';
import { AgentErrors, blocksAgentError } from './errors.js';
import { BedrockModels } from './models.js';
import type { AgentConfig, AgentCoreStreamResult, DefaultToolContext } from './types.js';

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

/**
 * Build the browser WebSocket URL for an AgentCore Runtime's `/ws` endpoint, embedding the
 * session id as the `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` query param (browsers can't
 * set the header). Mirrors the bedrock-agentcore SDK's data-plane URL construction; kept inline
 * so the AWS runtime layer has no extra dependency just to format a string. Region is read from
 * the ARN (5th `:`-delimited field). Verified live against a deployed runtime.
 */
export function buildAgentCoreWsUrl(runtimeArn: string, sessionId: string): string {
	const region = runtimeArn.split(':')[3];
	if (!region) throw new Error(`Cannot derive region from AgentCore Runtime ARN: ${runtimeArn}`);
	const url = new URL(`https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(runtimeArn)}/ws`);
	url.searchParams.set('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id', sessionId);
	return url.toString().replace(/^https:\/\//, 'wss://');
}

export class Agent<TContext = DefaultToolContext> extends AgentBase<TContext> {
	constructor(scope: ScopeParent, id: string, config: AgentConfig<TContext>) {
		super(scope, id, config, config.model?.deployed ?? BedrockModels.BALANCED, createDeployedSnapshotStorage);
	}

	/** Config key under which index.cdk.ts registers this agent's AgentCore Runtime ARN. */
	private get runtimeArnKey(): string {
		return `BB_AGENT_${this.fullId}_RUNTIME_ARN`;
	}

	/**
	 * Return the AgentCore Runtime endpoint + session id the browser should stream to.
	 *
	 * On AWS the browser opens a WebSocket DIRECTLY to the AgentCore Runtime (it does not
	 * proxy through this Lambda), so a turn is not bounded by the API-Gateway ~30s cap and
	 * long-running / streaming agents work. The client calls this to discover the `wsUrl`,
	 * pairs it with a JWT from its auth BB (this method stays auth-agnostic and returns no
	 * token), and opens the socket for both the initial turn and any HITL resume — the agent
	 * loop runs inside the AgentCore process (agentcore-entry.ts → streamSSE), which also
	 * persists history and approval records. `sessionId` maps to conversationId.
	 */
	async getStreamEndpoint(options?: { conversationId?: string }): Promise<AgentCoreStreamResult> {
		const sessionId = options?.conversationId ?? crypto.randomUUID();
		const runtimeArn = await getConfig(this.runtimeArnKey);
		if (!runtimeArn)
			throw blocksAgentError(
				AgentErrors.StreamFailed,
				`AgentCore Runtime ARN not found (config key ${this.runtimeArnKey}). Ensure the app build produced the AgentCore asset and the stack deployed the Runtime.`,
			);
		const wsUrl = buildAgentCoreWsUrl(runtimeArn, sessionId);
		return { runtimeArn, wsUrl, sessionId, toJSON: () => ({ runtimeArn, wsUrl, sessionId }) };
	}
}
