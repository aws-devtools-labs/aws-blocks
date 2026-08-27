// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { blocksError, KnowledgeBaseErrors } from './errors.js';

/** Bedrock caps `numberOfResults` at 1–100. */
const MIN_RESULTS = 1;
const MAX_RESULTS = 100;
const DEFAULT_RESULTS = 10;

/**
 * Normalize `RetrieveOptions.maxResults` into a valid Bedrock `numberOfResults`.
 *
 * Bedrock requires an **integer** in the range 1–100. A finite integer outside
 * that range is clamped (preserving the documented behavior). A fractional or
 * non-finite value (`1.5`, `NaN`, `Infinity`) — which can arise when the option
 * is derived from user input or a calculation — is rejected with
 * {@link KnowledgeBaseErrors.ValidationError}, so the mock and AWS runtimes never
 * diverge on an input Bedrock would reject.
 *
 * @param maxResults - The caller-supplied value, or `undefined` for the default.
 * @returns An integer in the range 1–100.
 * @throws {KnowledgeBaseValidationError} If `maxResults` is defined but not an integer.
 */
export function normalizeMaxResults(maxResults: number | undefined): number {
	if (maxResults === undefined) return DEFAULT_RESULTS;
	if (!Number.isInteger(maxResults)) {
		throw blocksError(
			KnowledgeBaseErrors.ValidationError,
			`maxResults must be an integer between ${MIN_RESULTS} and ${MAX_RESULTS}, got ${maxResults}.`,
		);
	}
	return Math.min(Math.max(maxResults, MIN_RESULTS), MAX_RESULTS);
}
