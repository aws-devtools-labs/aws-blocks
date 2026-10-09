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
 * The shape of a read error worth logging: the deepest AWS error in the `cause`
 * chain, flattened to the three fields that identify what S3 actually returned.
 * All optional — a non-AWS error (a JSON parse failure, a plain `Error`) carries
 * none of them, which is itself diagnostic.
 */
interface ReadErrorShape {
	/** Deepest error `name` (e.g. `NotFound`, `AccessDenied`, `ServiceUnavailable`). */
	name?: string;
	/** `$metadata.httpStatusCode` from the AWS SDK response, if present. */
	httpStatusCode?: number;
	/** `$metadata.requestId` — lets a captured occurrence be found in CloudTrail/S3 access logs. */
	requestId?: string;
	/** `true` when the shape looks like a missing object (a 404 / `NotFound`). */
	looksMissing: boolean;
}

/**
 * Walks a bounded `cause` chain and extracts the shape of the underlying read error.
 *
 * S3Storage wraps a GetObject failure as `SessionError('S3 error reading <key>', { cause })`,
 * so the raw AWS error arrives on `.cause` (set via Error options, NON-enumerable — which is
 * exactly why `bb-logger`'s top-level `name`/`message`/`stack` serialization never surfaces it,
 * and why we flatten it explicitly here). We read `name` and the SDK's `$metadata`
 * (`httpStatusCode`, `requestId`) from the deepest node that carries them, so a captured
 * occurrence in production records the concrete error — the piece issue tracking has been
 * missing — instead of only the opaque `S3 error reading <key>` message string.
 *
 * `looksMissing` flags a 404 / `NotFound` shape. It is used ONLY to word the diagnostic
 * (expected first-turn miss vs. an unexpected read error that we tolerated anyway); it is
 * NOT a gate on the read-path fallback — see {@link ResilientSnapshotStorage}.
 */
function readErrorShape(error: unknown): ReadErrorShape {
	const shape: ReadErrorShape = { looksMissing: false };
	let current: unknown = error;
	for (let depth = 0; current !== null && typeof current === 'object' && depth < 5; depth++) {
		if (shape.name === undefined && 'name' in current && typeof current.name === 'string' && current.name !== 'SessionError') {
			shape.name = current.name;
		}
		if ('$metadata' in current && current.$metadata !== null && typeof current.$metadata === 'object') {
			const metadata = current.$metadata;
			if (shape.httpStatusCode === undefined && 'httpStatusCode' in metadata && typeof metadata.httpStatusCode === 'number') {
				shape.httpStatusCode = metadata.httpStatusCode;
			}
			if (shape.requestId === undefined && 'requestId' in metadata && typeof metadata.requestId === 'string') {
				shape.requestId = metadata.requestId;
			}
		}
		current = 'cause' in current ? current.cause : undefined;
	}
	shape.looksMissing = shape.name === 'NotFound' || shape.name === 'NoSuchKey' || shape.name === 'NoSuchBucket' || shape.httpStatusCode === 404;
	return shape;
}

/**
 * Wraps the deployed `SnapshotStorage` so a first turn is never crashed by a session
 * snapshot that cannot be READ.
 *
 * On the first turn of a brand-new conversation no snapshot exists yet. Strands'
 * `SessionManager` treats a `null` from `loadSnapshot` (and an empty manifest from
 * `loadManifest`) as "start fresh" — the contract the local FileBucket storage
 * already honours. S3Storage maps `NoSuchKey`/`NoSuchBucket` to `null`, but a
 * missing object can also surface as a `NotFound` name, a bare HTTP 404, or — as
 * the originating issue's own source analysis flags — an `AccessDenied` S3 can
 * return for a missing object, a regional-endpoint edge, or a transient fault. Any
 * of those rethrows as `SessionError('S3 error reading <key>')`, propagates out of
 * the restore loop, and fails the whole first turn with no session ever starting.
 *
 * BOTH READ paths taken before any snapshot is written (`loadSnapshot`,
 * `loadManifest`) therefore fall back to the fresh-session value on ANY read error.
 * This is deliberately BROAD, not a `404`-only match: the production error shape was
 * never observed (the issue records only the opaque `S3 error reading <key>` message
 * — no `name`/`statusCode` was ever logged), and a sandbox deploy showed the genuine
 * missing-object path is already absorbed by S3Storage before this wrapper, so a
 * `404`-only match left the real P1 crash — whatever its shape — unfixed. A read
 * that fails for ANY reason on the pre-write path means there is nothing to restore,
 * so the correct action is to start fresh, exactly as the local storage does when
 * `bucket.get` is falsy. The alternative — rethrow and crash the first turn — is the
 * bug this fix exists to remove.
 *
 * Diagnostics are NOT discarded by starting fresh: every tolerated read error is
 * logged at `error` level (above the deployed agent's default `error` log level, so
 * it is actually emitted) with the deepest cause's `name`, `httpStatusCode` and
 * `requestId` flattened out of the non-enumerable `.cause` (see
 * {@link readErrorShape}) — the concrete shape the issue needs to decide whether a
 * narrower match is ever warranted. A shape that does not look like a missing object
 * is logged distinctly ("unexpected read error … starting fresh anyway") so a real
 * recurring permission/throttle fault stays visible and actionable rather than
 * silently absorbed.
 *
 * WRITE, delete and list paths are delegated untouched: a failure there is a real
 * persistence fault with state to lose, and must still surface.
 *
 * A read fallback cannot tell a never-written object apart from one that was deleted
 * or lost, so a failing read ALWAYS starts fresh, not only on a genuine first turn.
 * An established conversation whose snapshot became unreadable would also restart
 * with no history. That matches the SDK's own `NoSuchKey → null` handling and the
 * local `FileBucketSnapshotStorage`, so it is consistent, not a regression — the
 * "first turn" framing describes the motivating case, not a guarantee that an
 * existing snapshot is immune to a fresh start if it cannot be read.
 */
export class ResilientSnapshotStorage implements SnapshotStorage {
	constructor(
		private readonly inner: SnapshotStorage,
		/**
		 * Logs a tolerated read-path error at `error` level. Receives the human message, the
		 * flattened {@link ReadErrorShape} (so the concrete S3 error is captured even though it
		 * rides on a non-enumerable `.cause`), and the raw cause for full-fidelity inspection.
		 */
		private readonly logRead: (message: string, shape: ReadErrorShape, cause: unknown) => void,
	) {}

	private freshStart(path: 'snapshot' | 'manifest', sessionId: string, cause: unknown): void {
		const shape = readErrorShape(cause);
		const subject = path === 'snapshot' ? 'session snapshot' : 'snapshot manifest';
		const message = shape.looksMissing
			? `No ${subject} found for ${sessionId}; starting a fresh session.`
			: `Could not read ${subject} for ${sessionId} (unexpected read error); starting a fresh session anyway to avoid crashing the turn.`;
		this.logRead(message, shape, cause);
	}

	async loadSnapshot(params: { location: SnapshotLocation; snapshotId?: string }): Promise<Snapshot | null> {
		try {
			return await this.inner.loadSnapshot(params);
		} catch (cause) {
			// Any read failure on the pre-write path means there is nothing to restore — start
			// fresh rather than crash the first turn. The concrete error shape is captured at
			// error level either way (expected miss vs. unexpected fault worded distinctly).
			this.freshStart('snapshot', params.location.sessionId, cause);
			return null;
		}
	}

	/**
	 * Same broad read-path fallback as {@link loadSnapshot}. The symmetry is deliberate:
	 * Strands' `SessionManager` restores a fresh session via `loadSnapshot` alone and does
	 * not read the manifest (the `SessionManager does not read the manifest on a fresh-session
	 * restore` parity test in index.test.ts pins this), so narrowing the manifest read any
	 * more tightly than the snapshot read would buy nothing while risking a different first-turn
	 * crash path if that assumption ever changes. A manifest read is diagnostic rather than
	 * turn-critical, which makes an any-error fresh start on it strictly safe.
	 */
	async loadManifest(params: { location: SnapshotLocation }): Promise<SnapshotManifest> {
		try {
			return await this.inner.loadManifest(params);
		} catch (cause) {
			this.freshStart('manifest', params.location.sessionId, cause);
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
 * endpoint (#120), and wrapping it in {@link ResilientSnapshotStorage} so a first
 * turn starts fresh instead of crashing when the snapshot cannot be read. The agent's
 * `log` is threaded in so the wrapper's diagnostics flow through bb-logger alongside
 * the rest of the agent's structured output. The tolerated read error is logged at
 * `error` level — the deployed agent's default log level is `error`, so a `warn` would
 * be dropped and the first real occurrence (the shape issue tracking needs) would never
 * surface — with the deepest cause's `name`, `httpStatusCode` and `requestId` lifted out
 * of the non-enumerable `.cause` and placed as top-level structured fields, since
 * bb-logger otherwise serializes only the outer `SessionError`'s name/message/stack.
 * `S3StorageImpl` is injectable so tests can assert the resulting config and the
 * fresh-start behaviour without depending on S3Storage/AWS SDK internals; production
 * uses the real one.
 */
export function createDeployedSnapshotStorage(
	bucket: FileBucket,
	log: ChildLogger,
	S3StorageImpl: new (config: S3StorageConfig) => SnapshotStorage = S3Storage,
): SnapshotStorage {
	return new ResilientSnapshotStorage(
		new S3StorageImpl({ bucket: bucket.fullId, region: process.env.AWS_REGION }),
		(message, shape, cause) =>
			log.error(message, {
				s3ErrorName: shape.name,
				httpStatusCode: shape.httpStatusCode,
				requestId: shape.requestId,
				looksMissing: shape.looksMissing,
				cause,
			}),
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
