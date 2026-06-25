// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
	BedrockAgentRuntimeClient,
	RetrieveCommand,
	type RetrievalFilter,
	type KnowledgeBaseRetrievalResult,
} from '@aws-sdk/client-bedrock-agent-runtime';
import {
	BedrockAgentClient,
	ListIngestionJobsCommand,
	GetIngestionJobCommand,
	type IngestionJobSummary,
} from '@aws-sdk/client-bedrock-agent';
import { Scope, registerSdkIdentifiers, getSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import type {
	KnowledgeBaseOptions,
	RetrieveOptions,
	RetrieveResult,
	MetadataFilter,
	WaitUntilReadyOptions,
} from './types.js';
import { KnowledgeBaseErrors } from './errors.js';
import { BB_NAME, BB_VERSION } from './version.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';

export type {
	KnowledgeBaseOptions,
	SourceConfig,
	ChunkingConfig,
	ChunkingStrategy,
	RetrieveOptions,
	RetrieveResult,
	MetadataFilter,
	WaitUntilReadyOptions,
} from './types.js';
export { KnowledgeBaseErrors } from './errors.js';

// ── Env var sanitization ───────────────────────────────────────────────────

const ENV_SANITIZE = /[^A-Z0-9]/g;

// Env var names must be [A-Z0-9_]. The fullId may contain hyphens/dots (e.g., "my-app.docs").
function envKey(fullId: string, suffix: string): string {
	return `BLOCKS_${fullId.toUpperCase().replace(ENV_SANITIZE, '_')}_${suffix}`;
}

// ── Error helpers ──────────────────────────────────────────────────────────

function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

/** Resolve after `ms` milliseconds. Used to space out readiness polls in `waitUntilReady()`. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Match only messages that clearly indicate a metadata filter issue.
// Default unknown ValidationExceptions to ValidationError — false negatives
// (filter error → generic) are less harmful than false positives (content
// block → "your filter is wrong").
const FILTER_ERROR_PATTERNS = [
	/field\b.*\bnot found/i,
	// Intentionally loose. This only ever matches retrieve-time ValidationExceptions,
	// where the user-controllable inputs reaching Bedrock are the (already non-empty)
	// query text and the metadata filter — so a "metadata attribute" mention is almost
	// always a filter problem (e.g. "metadata attribute ... not found"). A stricter
	// "not found"/"key" anchor was considered but rejected: Bedrock's exact wording
	// varies by vector store and version, so tightening risks dropping real filter
	// errors. Anything unmatched already falls through to ValidationError below.
	/metadata.*attribute/i,
	/invalid.*filter|filter.*invalid/i,
	/filter\b.*\bkey\b.*\bnot/i,
];

function isFilterRelatedValidation(message: string): boolean {
	return FILTER_ERROR_PATTERNS.some((p) => p.test(message));
}

function mapSdkError(err: unknown): Error {
	// Non-Error throw (e.g., string or object) — stringify for diagnostics. There
	// is no underlying Error to attach, so `cause` is left unset.
	if (!(err instanceof Error)) {
		return blocksError(KnowledgeBaseErrors.RetrievalFailed, String(err));
	}

	let mapped: Error;
	if (err.name === 'ResourceNotFoundException') {
		mapped = blocksError(
			KnowledgeBaseErrors.NotReady,
			`Knowledge base not found. Run \`cdk deploy\` first. (${err.message})`,
		);
	} else if (err.name === 'ValidationException' && isFilterRelatedValidation(err.message)) {
		mapped = blocksError(KnowledgeBaseErrors.InvalidFilter, err.message);
	} else if (err.name === 'ValidationException') {
		mapped = blocksError(KnowledgeBaseErrors.ValidationError, err.message);
	} else {
		// Catch-all for unrecognized SDK errors (network, auth, throttling, etc.).
		mapped = blocksError(KnowledgeBaseErrors.RetrievalFailed, err.message);
	}

	// Preserve the original SDK error as the standard `Error.cause` for diagnostics
	// (keeps its original name, message, and stack). Defined NON-ENUMERABLE so
	// `JSON.stringify(mapped)` cannot leak the SDK error's $metadata (requestId/cfId);
	// the cause stays programmatically accessible (`mapped.cause === err`).
	Object.defineProperty(mapped, 'cause', { value: err, enumerable: false, writable: true, configurable: true });
	return mapped;
}

/**
 * Whether a mapped readiness error is a *transient* control-plane failure worth
 * a bounded retry in {@link KnowledgeBase.waitUntilReady}. True only for
 * `RetrievalFailedException` — the bucket {@link mapSdkError} uses for network
 * errors, throttling, and other unrecognized SDK failures. Terminal errors
 * (`IngestionFailedException`, `KnowledgeBaseNotReadyException`, and the
 * validation errors) map to other names and are intentionally excluded so they
 * short-circuit the wait immediately.
 */
function isTransientControlPlaneError(err: unknown): boolean {
	return err instanceof Error && err.name === KnowledgeBaseErrors.RetrievalFailed;
}

// ── Filter builder ─────────────────────────────────────────────────────────

function buildFilter(filter?: MetadataFilter): RetrievalFilter | undefined {
	if (!filter) return undefined;

	const keys = Object.keys(filter);
	if (keys.length === 0) return undefined;

	const filters: RetrievalFilter[] = keys.map((key) => ({
		equals: { key, value: filter[key].equals },
	}));

	if (filters.length === 1) return filters[0];
	return { andAll: filters };
}

// ── AWS Runtime KnowledgeBase ──────────────────────────────────────────────

/**
 * Production KnowledgeBase implementation backed by Amazon Bedrock Knowledge Bases.
 *
 * Reads `BLOCKS_{FULLID}_KB_ID` from environment variables (injected by the CDK
 * layer at deploy time). Uses the Bedrock `RetrieveCommand` for semantic retrieval.
 *
 * **When to use:** You need natural-language search over your own documents —
 * FAQs, product guides, support articles, internal wikis. Point it at a
 * `./knowledge` folder and call `retrieve()`.
 *
 * **When NOT to use:** If you need structured key-value lookups, use `KVStore`.
 * If you need relational queries, use `Database`. If you need full-text keyword
 * search with DynamoDB indexes, use `DistributedTable`.
 *
 * **Best practices:**
 * - Organize documents in subfolders to auto-populate `folder` metadata for filtering
 * - Keep individual documents focused on one topic for better chunk relevance
 *
 * **Scaling:** Serverless — no provisioned capacity. Embedding cost ~$0.00002
 * per 1,000 tokens. Vector storage via S3 Vectors (pay-per-query).
 * Max document size 50 MB. Supported formats include PDF, DOCX on AWS in
 * addition to .md, .txt, .html, .htm, .csv, .json.
 *
 * **Environment variables (injected by CDK):**
 * - `BLOCKS_{FULLID}_KB_ID` — Bedrock Knowledge Base ID
 * - `BLOCKS_{FULLID}_DATA_SOURCE_ID` — Bedrock data source ID (used by `isReady()` / `waitUntilReady()`)
 */
export class KnowledgeBase extends Scope {
	readonly bbName = BB_NAME;
	private readonly fullIdCached: string;
	private readonly runtimeClient: BedrockAgentRuntimeClient;
	private readonly agentClient: BedrockAgentClient;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, _options: KnowledgeBaseOptions) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = _options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.fullIdCached = this.fullId;
		this.runtimeClient = new BedrockAgentRuntimeClient({
			maxAttempts: 3,
			retryMode: 'adaptive',
			customUserAgent: this.buildUserAgentChain(),
		});
		// Control-plane client for ingestion-job status (readiness checks).
		this.agentClient = new BedrockAgentClient({
			maxAttempts: 3,
			retryMode: 'adaptive',
			customUserAgent: this.buildUserAgentChain(),
		});
		const kbId = process.env[envKey(this.fullIdCached, 'KB_ID')] ?? '';
		const dataSourceId = process.env[envKey(this.fullIdCached, 'DATA_SOURCE_ID')] ?? '';
		registerSdkIdentifiers(this.fullId, { kbId, dataSourceId });
	}

	private ensureKbId(): string {
		const kbId = getSdkIdentifiers(this).kbId;
		if (kbId) return kbId;
		const kbEnv = envKey(this.fullIdCached, 'KB_ID');
		throw blocksError(
			KnowledgeBaseErrors.NotReady,
			`Environment variable ${kbEnv} is not set. Run \`cdk deploy\` first.`,
		);
	}

	/**
	 * Resolve the configured Bedrock data source id, or `undefined` when none
	 * was registered. Both folder and imported `s3://` sources register a
	 * BB-managed data source id at deploy time, so this normally returns a value
	 * for either source type. It is `undefined` only for deployments that predate
	 * the readiness API (no `DATA_SOURCE_ID` injected) — in which case there is no
	 * ingestion job to track and callers treat the KB as ready.
	 */
	private ensureDataSourceId(): string | undefined {
		const dataSourceId = getSdkIdentifiers(this).dataSourceId;
		return dataSourceId ? dataSourceId : undefined;
	}

	/**
	 * Retrieve relevant document chunks for a natural language query.
	 *
	 * Calls the Bedrock `RetrieveCommand` with the configured knowledge base ID.
	 *
	 * @param query - Natural language search query. Must be non-empty.
	 * @param {RetrieveOptions} options - Optional retrieval parameters (maxResults, filter).
	 * @returns Chunks ranked by relevance score (highest first). Empty array if no matches.
	 * @throws {KnowledgeBaseValidationError} If query is empty or whitespace-only.
	 * @throws {KnowledgeBaseNotReadyException} If the KB has not been created/deployed.
	 * @throws {InvalidFilterException} If the filter keys are invalid for the Bedrock query.
	 * @throws {RetrievalFailedException} For other Bedrock retrieval errors (network, service).
	 *
	 * @example
	 * ```typescript
	 * const results = await kb.retrieve('how do I reset my password', {
	 *   maxResults: 5,
	 *   filter: { folder: { equals: 'faq' } },
	 * });
	 * ```
	 */
	async retrieve(query: string, options?: RetrieveOptions): Promise<RetrieveResult[]> {
		if (typeof query !== 'string' || !query.trim()) {
			throw blocksError(KnowledgeBaseErrors.ValidationError, 'Query must be a non-empty string.');
		}

		// Bedrock API limits numberOfResults to 1–100. Well within Lambda's 6 MB response payload.
		const maxResults = Math.min(Math.max(options?.maxResults ?? 10, 1), 100);
		const filter = buildFilter(options?.filter);
		const knowledgeBaseId = this.ensureKbId();

		try {
			const response = await this.runtimeClient.send(
				new RetrieveCommand({
					knowledgeBaseId,
					retrievalQuery: { text: query },
					retrievalConfiguration: {
						vectorSearchConfiguration: {
							numberOfResults: maxResults,
							...(filter ? { filter } : {}),
						},
					},
				}),
			);

			const results: RetrieveResult[] = [];
			for (const item of response.retrievalResults ?? []) {
				results.push(mapResultItem(item));
			}

			return results;
		} catch (err) {
			const mapped = mapSdkError(err);
			this.log.error(mapped.message);
			throw mapped;
		}
	}

	/**
	 * Report whether the knowledge base has finished ingesting and is ready to
	 * serve `retrieve()` calls.
	 *
	 * Bedrock ingestion runs asynchronously after deploy (it is triggered
	 * fire-and-forget), so during the warm-up window `retrieve()` returns an
	 * empty array even for queries that will later match. Use `isReady()` to
	 * distinguish "still warming up" (`false`) from "ingested, genuinely no
	 * match" (`true` alongside an empty `retrieve()` result).
	 *
	 * Resolution strategy: lists the data source's ingestion jobs (most recent
	 * first) and inspects the latest job's status — `COMPLETE` → ready,
	 * `FAILED` → throws, anything else (`STARTING` / `IN_PROGRESS`, or no jobs
	 * yet) → not ready. Both folder and imported `s3://` sources register a
	 * BB-managed data source id, so both are tracked here; the "no data source
	 * id configured → reported ready" shortcut applies only to deployments that
	 * predate this API (no `DATA_SOURCE_ID` injected — nothing to track).
	 *
	 * @returns `true` when the latest ingestion job is `COMPLETE` (or there is
	 *   no managed data source to track); `false` while ingestion is pending.
	 * @throws {IngestionFailedException} If the most recent ingestion job failed (message includes `failureReasons`).
	 * @throws {KnowledgeBaseNotReadyException | KnowledgeBaseValidationError | InvalidFilterException | RetrievalFailedException}
	 *   For mapped Bedrock control-plane errors. The `KB_ID` env var being unset, and a
	 *   control-plane `ResourceNotFoundException`, both map to `NotReady`; a control-plane
	 *   `ValidationException` maps to `KnowledgeBaseValidationError` (or `InvalidFilterException`);
	 *   any other SDK error (network, auth, throttling) maps to `RetrievalFailedException`.
	 *   This is the same mapping {@link mapSdkError} applies to `retrieve()`.
	 *
	 * @example
	 * ```typescript
	 * if (await kb.isReady()) {
	 *   const results = await kb.retrieve('how do I reset my password');
	 * }
	 * ```
	 */
	async isReady(): Promise<boolean> {
		const knowledgeBaseId = this.ensureKbId();
		const dataSourceId = this.ensureDataSourceId();
		// No BB-managed ingestion to track → nothing to wait for.
		if (!dataSourceId) return true;

		const job = await this.fetchLatestIngestionJob(knowledgeBaseId, dataSourceId);
		// No ingestion job recorded yet → ingestion has not started; still warming.
		if (!job) return false;

		if (job.status === 'COMPLETE') return true;
		if (job.status === 'FAILED') {
			const reasons = await this.fetchFailureReasons(knowledgeBaseId, dataSourceId, job.ingestionJobId);
			throw blocksError(
				KnowledgeBaseErrors.IngestionFailed,
				`Knowledge base ingestion failed.${reasons.length ? ` Reasons: ${reasons.join('; ')}` : ''}`,
			);
		}
		// STARTING | IN_PROGRESS | STOPPING | STOPPED → not ready.
		return false;
	}

	/**
	 * Wait until the knowledge base has finished ingesting, polling its
	 * ingestion-job status until ready or until the timeout elapses.
	 *
	 * Polls {@link isReady} every `pollIntervalMs` until it returns `true`
	 * (resolves) or the `timeoutMs` budget is exhausted (throws). If the most
	 * recent ingestion job has `FAILED`, the underlying `IngestionFailedException`
	 * propagates immediately rather than waiting out the timeout.
	 *
	 * Because this method exists for the noisy post-deploy window, it tolerates a
	 * bounded run of *transient* control-plane errors (throttling / transient
	 * network failures, mapped to `RetrievalFailedException`) rather than aborting
	 * on the first blip: up to `maxConsecutiveTransientErrors` consecutive transient
	 * failures are absorbed and retried, and any clean poll resets that counter.
	 * Terminal errors still short-circuit immediately — a `FAILED` job
	 * (`IngestionFailedException`) and a missing-KB config error
	 * (`KnowledgeBaseNotReadyException`, e.g. `KB_ID` unset) are never retried.
	 *
	 * @param {WaitUntilReadyOptions} options - Optional polling parameters.
	 *   `timeoutMs` (default 300000) bounds the total wait; `pollIntervalMs`
	 *   (default 5000, clamped to a minimum of 1ms) spaces out the polls;
	 *   `maxConsecutiveTransientErrors` (default 3, minimum 0) bounds how many
	 *   consecutive transient control-plane errors are tolerated before giving up.
	 * @throws {KnowledgeBaseTimeoutException} If the KB does not become ready within `timeoutMs`.
	 * @throws {IngestionFailedException} If the most recent ingestion job failed (message includes `failureReasons`).
	 * @throws {KnowledgeBaseNotReadyException | KnowledgeBaseValidationError | InvalidFilterException | RetrievalFailedException}
	 *   Propagated from {@link isReady} for mapped Bedrock control-plane errors — see its docs
	 *   for the full mapping (`ResourceNotFoundException`/unset `KB_ID` → `NotReady`,
	 *   `ValidationException` → `KnowledgeBaseValidationError`/`InvalidFilterException`,
	 *   other SDK errors → `RetrievalFailedException`). Transient `RetrievalFailedException`s
	 *   are retried up to `maxConsecutiveTransientErrors` times before being rethrown.
	 *
	 * @example
	 * ```typescript
	 * // Block until the KB is queryable (e.g. right after deploy)
	 * await kb.waitUntilReady({ timeoutMs: 600_000 });
	 * const results = await kb.retrieve('getting started');
	 * ```
	 */
	async waitUntilReady(options?: WaitUntilReadyOptions): Promise<void> {
		const timeoutMs = Math.max(options?.timeoutMs ?? 300_000, 0);
		const pollIntervalMs = Math.max(options?.pollIntervalMs ?? 5_000, 1);
		const maxConsecutiveTransientErrors = Math.max(options?.maxConsecutiveTransientErrors ?? 3, 0);
		const deadline = Date.now() + timeoutMs;

		let consecutiveTransientErrors = 0;
		for (;;) {
			try {
				// isReady() resolves true (ready) / false (still warming), throws
				// IngestionFailedException on a FAILED job, NotReady when the KB is
				// not deployed, or RetrievalFailedException for transient blips.
				if (await this.isReady()) return;
				// A clean poll clears any transient-error streak.
				consecutiveTransientErrors = 0;
			} catch (err) {
				// Terminal errors (FAILED job, missing-KB config, validation) short-circuit.
				if (!isTransientControlPlaneError(err)) throw err;
				// Transient control-plane blip: absorb a bounded run, then give up.
				consecutiveTransientErrors += 1;
				if (consecutiveTransientErrors > maxConsecutiveTransientErrors) throw err;
				this.log.warn(
					`waitUntilReady: tolerating transient control-plane error ` +
						`(${consecutiveTransientErrors}/${maxConsecutiveTransientErrors}), retrying: ${(err as Error).message}`,
				);
			}
			if (Date.now() >= deadline) {
				throw blocksError(
					KnowledgeBaseErrors.Timeout,
					`Knowledge base did not become ready within ${timeoutMs}ms.`,
				);
			}
			// Never sleep past the deadline.
			await sleep(Math.min(pollIntervalMs, Math.max(deadline - Date.now(), 0)));
		}
	}

	/**
	 * List the data source's ingestion jobs (most recent first) and return the
	 * latest summary, or `undefined` when none exist yet. SDK errors are mapped
	 * to Blocks error constants via {@link mapSdkError}.
	 */
	private async fetchLatestIngestionJob(
		knowledgeBaseId: string,
		dataSourceId: string,
	): Promise<IngestionJobSummary | undefined> {
		try {
			const response = await this.agentClient.send(
				new ListIngestionJobsCommand({
					knowledgeBaseId,
					dataSourceId,
					sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' },
					maxResults: 1,
				}),
			);
			return response.ingestionJobSummaries?.[0];
		} catch (err) {
			const mapped = mapSdkError(err);
			this.log.error(mapped.message);
			throw mapped;
		}
	}

	/**
	 * Fetch the `failureReasons` for a failed ingestion job. Best-effort: the
	 * `ListIngestionJobs` summary omits failure reasons, so this issues a
	 * `GetIngestionJob` for the detail. Returns an empty array if the id is
	 * missing or the lookup fails — the caller still reports the failure.
	 */
	private async fetchFailureReasons(
		knowledgeBaseId: string,
		dataSourceId: string,
		ingestionJobId: string | undefined,
	): Promise<string[]> {
		if (!ingestionJobId) return [];
		try {
			const response = await this.agentClient.send(
				new GetIngestionJobCommand({ knowledgeBaseId, dataSourceId, ingestionJobId }),
			);
			const reasons = response.ingestionJob?.failureReasons ?? [];
			if (reasons.length === 0) {
				// A FAILED job with no reported reasons is unusual — surface a hint so
				// the otherwise reason-less IngestionFailedException is easier to diagnose.
				this.log.warn(
					`Ingestion job ${ingestionJobId} is FAILED but reported no failureReasons; ` +
						`the surfaced error will not include a cause.`,
				);
			}
			return reasons;
		} catch (err) {
			this.log.error(mapSdkError(err).message);
			return [];
		}
	}
}

// ── Result mapping ─────────────────────────────────────────────────────────

function mapResultItem(item: KnowledgeBaseRetrievalResult): RetrieveResult {
	const text = item.content?.text ?? '';
	const score = item.score ?? 0;
	const source = item.location?.s3Location?.uri ?? '';

	// Bedrock returns `x-amz-bedrock-*` internal keys (filtered out) plus any custom
	// metadata from S3 object metadata or data source metadata configuration.
	const metadata: Record<string, string> = {};
	if (item.metadata) {
		for (const [key, value] of Object.entries(item.metadata)) {
			if (key.startsWith('x-amz-bedrock')) continue;
			if (typeof value === 'string') {
				metadata[key] = value;
			} else if (value != null) {
				metadata[key] = String(value);
			}
		}
	}

	return { text, score, source, metadata };
}
