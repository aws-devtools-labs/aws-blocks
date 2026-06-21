// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
	BedrockAgentRuntimeClient,
	RetrieveCommand,
	type RetrievalFilter,
	type KnowledgeBaseRetrievalResult,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { Scope, registerSdkIdentifiers, getSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import type { KnowledgeBaseOptions, RetrieveOptions, RetrieveResult, MetadataFilter } from './types.js';
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

// Match only messages that clearly indicate a metadata filter issue.
// Default unknown ValidationExceptions to ValidationError — false negatives
// (filter error → generic) are less harmful than false positives (content
// block → "your filter is wrong").
const FILTER_ERROR_PATTERNS = [
	/field\b.*\bnot found/i,
	// Targets filter-attribute lookup messages (e.g. "metadata attribute ... not found").
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
		mapped = blocksError(KnowledgeBaseErrors.NotReady, 'Knowledge base not found. Run `cdk deploy` first.');
	} else if (err.name === 'ValidationException' && isFilterRelatedValidation(err.message)) {
		mapped = blocksError(KnowledgeBaseErrors.InvalidFilter, err.message);
	} else if (err.name === 'ValidationException') {
		mapped = blocksError(KnowledgeBaseErrors.ValidationError, err.message);
	} else {
		// Catch-all for unrecognized SDK errors (network, auth, throttling, etc.).
		mapped = blocksError(KnowledgeBaseErrors.RetrievalFailed, err.message);
	}

	// Genuinely preserve the original SDK error as the standard `Error.cause`. The
	// mapped error normalizes `name`/`message` for callers, so attaching the
	// untouched SDK error keeps its original name, message, and stack for diagnostics.
	mapped.cause = err;
	return mapped;
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
 */
export class KnowledgeBase extends Scope {
	readonly bbName = BB_NAME;
	private readonly fullIdCached: string;
	private readonly runtimeClient: BedrockAgentRuntimeClient;

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
		const kbId = process.env[envKey(this.fullIdCached, 'KB_ID')] ?? '';
		registerSdkIdentifiers(this.fullId, { kbId });
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
		if (!query?.trim()) {
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
