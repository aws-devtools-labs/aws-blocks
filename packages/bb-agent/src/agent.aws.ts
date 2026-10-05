// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { getConfig, installClientUserAgent } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import type { FileBucket } from '@aws-blocks/bb-file-bucket';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { Snapshot, SnapshotLocation, SnapshotManifest, SnapshotStorage } from '@strands-agents/sdk';
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
 * An empty manifest means "no snapshots recorded yet" — the same value the local
 * FileBucket-backed storage and S3Storage both return for a scope with no manifest.
 */
function freshManifest(): SnapshotManifest {
	return { schemaVersion: '1.0', updatedAt: new Date().toISOString() };
}

/**
 * Returns true when `error` (or its `cause` chain) represents a MISSING S3 object
 * — a 404 the SDK's own `NoSuchKey`/`NoSuchBucket` check does not recognise.
 *
 * S3Storage wraps a GetObject failure as `SessionError('S3 error reading <key>', { cause })`,
 * so the raw AWS error arrives on `cause`. A missing object surfaces as a `NoSuchKey`/
 * `NoSuchBucket`/`NotFound` error name or an HTTP 404 in the SDK's `$metadata`. We walk a
 * bounded `cause` chain because the raw error may be nested one wrapper deep.
 *
 * Everything else — a `403 AccessDenied` (a genuine permission gap; S3 does NOT mask a
 * missing object as 403 here because the execution role is granted `s3:ListBucket`), a
 * transient `5xx`/throttle, an invalid-JSON parse failure on a corrupt object — is NOT a
 * missing object and must surface, so an established conversation is never silently
 * discarded by a fault that a crash-and-retry would have preserved.
 */
function isMissingObjectError(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; current !== null && typeof current === 'object' && depth < 5; depth++) {
		if ('name' in current) {
			const name = current.name;
			if (name === 'NoSuchKey' || name === 'NoSuchBucket' || name === 'NotFound') {
				return true;
			}
		}
		if ('$metadata' in current && current.$metadata !== null && typeof current.$metadata === 'object' && 'httpStatusCode' in current.$metadata && current.$metadata.httpStatusCode === 404) {
			return true;
		}
		current = 'cause' in current ? current.cause : undefined;
	}
	return false;
}

/**
 * Wraps the deployed `SnapshotStorage` so a first turn is never crashed by a MISSING
 * session snapshot.
 *
 * On the first turn of a brand-new conversation no snapshot exists yet. Strands'
 * `SessionManager` treats a `null` from `loadSnapshot` (and an empty manifest from
 * `loadManifest`) as "start fresh" — the contract the local FileBucket storage
 * already honours. S3Storage, however, only maps `NoSuchKey`/`NoSuchBucket` to
 * `null`; a missing object that surfaces as `NotFound` or an HTTP 404 is instead
 * rethrown as `SessionError('S3 error reading <key>')`, which propagates out of the
 * loop and fails the whole first turn with no session ever starting.
 *
 * The two READ paths taken before any snapshot is written (`loadSnapshot`,
 * `loadManifest`) therefore fall back to the fresh-session value ONLY when the
 * underlying error is a missing-object 404 (see {@link isMissingObjectError}),
 * logging the cause either way. The fallback is deliberately NARROW: a non-404
 * fault (a `403 AccessDenied` permission gap, a transient `5xx`/throttle, a
 * corrupt-snapshot parse error) is rethrown — on an EXISTING conversation that
 * preserves the persisted state for a crash-and-retry instead of silently resuming
 * from a fresh session and discarding it. Write, delete and list paths are delegated
 * untouched: a failure there is a real persistence fault and must still surface.
 */
export class ResilientSnapshotStorage implements SnapshotStorage {
	constructor(
		private readonly inner: SnapshotStorage,
		private readonly warn: (message: string, cause: unknown) => void = (message, cause) => console.warn(message, cause),
	) {}

	async loadSnapshot(params: { location: SnapshotLocation; snapshotId?: string }): Promise<Snapshot | null> {
		try {
			return await this.inner.loadSnapshot(params);
		} catch (cause) {
			if (!isMissingObjectError(cause)) {
				this.warn(`Failed to read session snapshot for ${params.location.sessionId}. Underlying error:`, cause);
				throw cause;
			}
			this.warn(
				`No session snapshot found for ${params.location.sessionId}; starting a fresh session. Underlying error:`,
				cause,
			);
			return null;
		}
	}

	/**
	 * Same 404-only fallback as {@link loadSnapshot}. The symmetry is deliberate and safe:
	 * Strands' `SessionManager` never calls `loadManifest` — the deployed agent's restore
	 * path is `_onAgentInitialized → restoreSnapshot → loadSnapshot` only, and no SDK code
	 * path reads the manifest (it is interface surface, not a runtime caller). So a non-404
	 * manifest read failure cannot abort a turn the way a `loadSnapshot` one could, and
	 * narrowing both identically keeps the two read paths consistent without reintroducing
	 * the first-turn crash via the manifest. Should a future SDK start reading the manifest
	 * on the first turn, revisit whether it needs a broader (non-404) fallback here — the
	 * `SessionManager does not read the manifest on a fresh-session restore` parity test in
	 * index.test.ts pins this assumption and fails loudly if an SDK bump breaks it.
	 */
	async loadManifest(params: { location: SnapshotLocation }): Promise<SnapshotManifest> {
		try {
			return await this.inner.loadManifest(params);
		} catch (cause) {
			if (!isMissingObjectError(cause)) {
				this.warn(`Failed to read snapshot manifest for ${params.location.sessionId}. Underlying error:`, cause);
				throw cause;
			}
			this.warn(
				`No snapshot manifest found for ${params.location.sessionId}; treating it as empty. Underlying error:`,
				cause,
			);
			return freshManifest();
		}
	}

	saveSnapshot(params: { location: SnapshotLocation; snapshotId: string; isLatest: boolean; snapshot: Snapshot }): Promise<void> {
		return this.inner.saveSnapshot(params);
	}

	listSnapshotIds(params: { location: SnapshotLocation; limit?: number; startAfter?: string }): Promise<string[]> {
		return this.inner.listSnapshotIds(params);
	}

	deleteSession(params: { sessionId: string }): Promise<void> {
		return this.inner.deleteSession(params);
	}

	saveManifest(params: { location: SnapshotLocation; manifest: SnapshotManifest }): Promise<void> {
		return this.inner.saveManifest(params);
	}
}

/**
 * Builds the deployed Agent's snapshot storage, pinning S3Storage to the Lambda
 * execution region (`AWS_REGION`) so non-us-east-1 deploys use the correct regional
 * endpoint, and wrapping it in {@link ResilientSnapshotStorage} so a first
 * turn starts fresh instead of crashing when no snapshot exists yet. The agent's
 * `log` is threaded in so the wrapper's fresh-start and rethrow diagnostics flow
 * through bb-logger alongside the rest of the agent's structured warnings, not raw
 * `console.warn`. `S3StorageImpl` is injectable so tests can assert the resulting
 * config and the fresh-start behaviour without depending on S3Storage/AWS SDK
 * internals; production uses the real one.
 */
export function createDeployedSnapshotStorage(
	bucket: FileBucket,
	log: ChildLogger,
	S3StorageImpl: new (config: S3StorageConfig) => SnapshotStorage = S3Storage,
): SnapshotStorage {
	return new ResilientSnapshotStorage(
		new S3StorageImpl({ bucket: bucket.fullId, region: process.env.AWS_REGION }),
		(message, cause) => log.warn(message, { cause }),
	);
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
				runtimeSessionId: toRuntimeSessionId(payload.conversationId ?? payload.channelId),
				contentType: 'application/json',
				accept: 'application/json',
				payload: new TextEncoder().encode(JSON.stringify(body)),
			}),
		);
	}
}
