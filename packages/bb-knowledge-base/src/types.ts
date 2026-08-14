// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for KnowledgeBase. Imported by mock, aws, browser, and cdk entry points.
 * This file has zero runtime dependencies — types only.
 */
import type { ChildLogger } from '@aws-blocks/bb-logger';

// ── Source Configuration ────────────────────────────────────────────────────

/**
 * Defines where the knowledge base sources its documents.
 *
 * - `string` (relative path) → folder mode, synced to S3 on deploy.
 *   Subfolders auto-populate `folder` metadata.
 * - `string` starting with `s3://` → existing S3 bucket.
 *
 * @example
 * ```typescript
 * // Local folder — synced to S3 on deploy
 * const source: SourceConfig = './knowledge';
 *
 * // Existing S3 bucket
 * const source: SourceConfig = 's3://my-docs-bucket';
 * ```
 */
export type SourceConfig = string;

// ── Chunking Configuration ─────────────────────────────────────────────────

/**
 * Strategy for splitting documents into searchable chunks.
 *
 * - `'semantic'` — (Default) Splits at natural topic boundaries using breakpoint detection.
 * - `'fixed'` — Fixed-size chunks with configurable `chunkSize` and `chunkOverlap`.
 * - `'hierarchical'` — Two-level chunking (parent 1500 tokens, child 300 tokens).
 * - `'none'` — No chunking; each document is a single chunk.
 */
export type ChunkingStrategy = 'semantic' | 'fixed' | 'hierarchical' | 'none';

/**
 * Configuration for how documents are split into searchable chunks.
 * Different strategies expose different tuning knobs — irrelevant options
 * are silently ignored.
 */
export interface ChunkingConfig {
	/** Chunking strategy. Default: `'semantic'`. */
	strategy?: ChunkingStrategy;
	/** Max tokens per chunk. Only used with `'fixed'` strategy. Default: 300. */
	chunkSize?: number;
	/**
	 * Overlap percentage between consecutive chunks (0–100). Only used with `'fixed'` strategy. Default: 20.
	 *
	 * **Parity note:** Interpreted as a *percentage* of `chunkSize` in both local
	 * development and production — the mock overlaps by `chunkSize * chunkOverlap / 100`
	 * words, and the CDK layer maps it to Bedrock's `overlapPercentage`. The value is
	 * directly transferable between environments. Bedrock accepts 1–99; the local mock
	 * also accepts 0 (no overlap).
	 */
	chunkOverlap?: number;
	/** Breakpoint percentile threshold for topic boundary detection (0–100). Only used with `'semantic'` strategy. Higher values = fewer, larger chunks. Default: 95. (No effect in local dev / mock.) */
	breakpointPercentile?: number;
}

// ── Constructor Options ────────────────────────────────────────────────────

/**
 * Constructor options for `KnowledgeBase`.
 *
 * @example
 * ```typescript
 * const kb = new KnowledgeBase(scope, 'docs', {
 *   source: './knowledge',
 *   chunking: { strategy: 'semantic' },
 *   embeddingDimensions: 1024,
 *   description: 'Product documentation',
 * });
 * ```
 */
export interface KnowledgeBaseOptions {
	/** Document source — local folder path (`'./knowledge'`) or S3 URI (`'s3://bucket/prefix'`). */
	source: SourceConfig;
	/** How documents are split into chunks. Default: `{ strategy: 'semantic' }`. */
	chunking?: ChunkingConfig;
	/** Embedding model output dimensions. Smaller values reduce cost and storage; larger values improve accuracy. Default: 1024. */
	embeddingDimensions?: 256 | 512 | 1024;
	/** Human-readable description for the knowledge base. Shown in the AWS console. */
	description?: string;
	/**
	 * CDK removal behavior for the data bucket (only for BB-created
	 * buckets; imported S3 URI sources are unaffected). When omitted,
	 * CDK's default applies (RETAIN — the bucket and its documents are
	 * preserved on `cdk destroy`).
	 *
	 * Pass `'destroy'` for sandbox / ephemeral stacks where the data
	 * bucket should be dropped on teardown. This also enables
	 * `autoDeleteObjects` so CloudFormation can empty the bucket before
	 * deletion. Pass `'retain'` to set the policy explicitly.
	 *
	 * Templates that apply `RemovalPolicies.of(stack).destroy()` at the
	 * top level override this setting.
	 */
	removalPolicy?: 'destroy' | 'retain';
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;
}

// ── Retrieve Options & Results ─────────────────────────────────────────────

/**
 * Tagged-union filter structure for metadata-based retrieval filtering.
 * All key-value pairs use AND semantics — every condition must match.
 *
 * v1 ships with `equals` only. The tagged-union structure makes it easy to add
 * `contains`, `startsWith`, `notEquals`, `greaterThan` etc. in future without
 * breaking changes.
 *
 * @example
 * ```typescript
 * // Single filter
 * const filter: MetadataFilter = { folder: { equals: 'faq' } };
 *
 * // Multiple filters (AND semantics)
 * const filter: MetadataFilter = {
 *   folder: { equals: 'products' },
 *   category: { equals: 'enterprise' },
 * };
 * ```
 */
export type MetadataFilter = Record<string, { equals: string }>;

/**
 * Options for the `retrieve()` method.
 */
export interface RetrieveOptions {
	/** Maximum results to return. Clamped to 1–100. Default: 10. */
	maxResults?: number;
	/** Metadata filter with AND semantics across all key-value pairs. Only chunks whose metadata matches every condition are returned. */
	filter?: MetadataFilter;
}

/**
 * A single retrieval result representing a matched document chunk.
 */
export interface RetrieveResult {
	/** The text content of the matched chunk. */
	text: string;
	/** Relevance score normalized to 0.0–1.0, where 1.0 is a perfect match. */
	score: number;
	/** Source document path (relative to source root) or URL. */
	source: string;
	/** Document metadata key-value pairs. Includes auto-populated `folder` key derived from subfolder structure. */
	metadata: Record<string, string>;
}

// ── Sync Options ───────────────────────────────────────────────────────────

/**
 * Options for the `waitUntilSynced()` method.
 *
 * @example
 * ```typescript
 * // Wait up to 10 minutes, polling every 10 seconds
 * await kb.waitUntilSynced({ timeoutMs: 600_000, pollIntervalMs: 10_000 });
 * ```
 */
export interface WaitUntilSyncedOptions {
	/**
	 * Maximum time to wait for ingestion to complete, in milliseconds. Default: 300000 (5 minutes).
	 *
	 * `timeoutMs: 0` is a one-shot check, not a no-poll fast-fail: the deadline is
	 * evaluated *after* the first `isSynced()` poll, so exactly one poll always
	 * runs (and can resolve the wait) before a `KnowledgeBaseTimeoutException` is
	 * thrown. No inter-poll sleep occurs in this case either — the sleep is
	 * `min(jitter, deadline − now)`, and the remaining-budget clamp drives it to 0
	 * when the budget is already spent. Clamped to a minimum of 0.
	 */
	timeoutMs?: number;
	/**
	 * Delay between sync polls, in milliseconds. Clamped to a minimum of 1ms.
	 * A small amount of random jitter (±20%) is applied to each delay so that many
	 * knowledge bases polling after a shared deploy do not fall into lockstep — the
	 * jitter only varies the wait *between* polls (never the number of polls) and is
	 * still clamped so a sleep never overruns `timeoutMs`. Default: 5000 (5 seconds).
	 */
	pollIntervalMs?: number;
	/**
	 * Maximum number of *consecutive* transient control-plane errors to tolerate
	 * before giving up, instead of aborting the wait on the first blip. Two kinds
	 * of error are treated as transient during a sync poll:
	 * - `RetrievalFailedException` — the catch-all for network failures, throttling,
	 *   and other unrecognized SDK errors.
	 * - A *not-yet-visible* knowledge base: in the post-deploy window the control
	 *   plane can briefly return `ResourceNotFoundException` (the KB or data source
	 *   isn't visible yet), which surfaces as `KnowledgeBaseNotReadyException`. Only
	 *   this control-plane variant is transient — riding it out is the whole point
	 *   of `waitUntilSynced()`.
	 *
	 * Each clean poll (ingestion still in progress, or synced) resets the counter,
	 * so only an unbroken run of failures counts toward the limit.
	 *
	 * Terminal errors always short-circuit immediately regardless of this value:
	 * `IngestionFailedException` (the job failed), a *config* `KnowledgeBaseNotReadyException`
	 * (the `KB_ID` env var is unset — distinct from the transient not-yet-visible case
	 * above), and validation errors. Set to `0` to fail fast on the first transient
	 * error. Clamped to a minimum of 0. Default: 3.
	 */
	maxConsecutiveTransientErrors?: number;
	/**
	 * Optional {@link AbortSignal} to cancel the wait. When the signal is aborted,
	 * `waitUntilSynced()` rejects promptly — checked before each poll and during the
	 * inter-poll delay — with the signal's abort reason (by default a `DOMException`
	 * named `'AbortError'`, or whatever value was passed to `AbortController.abort(reason)`).
	 * An already-aborted signal rejects immediately, before any polling.
	 */
	signal?: AbortSignal;
}
