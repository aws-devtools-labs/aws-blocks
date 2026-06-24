// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed error constants for KnowledgeBase. Use with `isBlocksError()` in catch blocks.
 *
 * @example
 * ```typescript
 * try {
 *   const results = await kb.retrieve('query');
 * } catch (e: unknown) {
 *   if (isBlocksError(e, KnowledgeBaseErrors.NotReady)) {
 *     // KB not yet ingested
 *   }
 * }
 * ```
 */
export const KnowledgeBaseErrors = {
	/** Bedrock retrieval call failed (network error, service outage, etc.). */
	RetrievalFailed: 'RetrievalFailedException',
	/** Knowledge base not yet deployed, or environment variables not set. Run `cdk deploy` first. */
	NotReady: 'KnowledgeBaseNotReadyException',
	/** Source folder not found, or source config is invalid for the current runtime. */
	InvalidSource: 'InvalidSourceConfigException',
	/** Invalid metadata filter keys or structure in the Bedrock query. */
	InvalidFilter: 'InvalidFilterException',
	/** Query validation error (e.g., empty or whitespace-only query string). */
	ValidationError: 'KnowledgeBaseValidationError',
	/** KnowledgeBase is server-side only and cannot be used in browser contexts. */
	BrowserNotSupported: 'BrowserNotSupportedException',
	/** The data source's most recent Bedrock ingestion job failed. The error message includes the reported `failureReasons`. */
	IngestionFailed: 'IngestionFailedException',
	/** `waitUntilReady()` exceeded its timeout before the knowledge base finished ingesting. */
	Timeout: 'KnowledgeBaseTimeoutException',
} as const;
