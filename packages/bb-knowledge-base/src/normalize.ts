// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { blocksError, KnowledgeBaseErrors } from './errors.js';
import type { SourceFormat } from './types.js';

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
 * `undefined` and `null` both mean "unset" and yield the default — parsed JSON
 * (e.g. from an agent/tool-calling layer) often sends `null` for an omitted field.
 *
 * @param maxResults - The caller-supplied value, or `undefined`/`null` for the default.
 * @returns An integer in the range 1–100.
 * @throws {KnowledgeBaseValidationError} If `maxResults` is set but not an integer.
 */
export function normalizeMaxResults(maxResults: number | undefined | null): number {
	if (maxResults === undefined || maxResults === null) return DEFAULT_RESULTS;
	if (!Number.isInteger(maxResults)) {
		throw blocksError(
			KnowledgeBaseErrors.ValidationError,
			`maxResults must be an integer between ${MIN_RESULTS} and ${MAX_RESULTS}, got ${maxResults}.`,
		);
	}
	return Math.min(Math.max(maxResults, MIN_RESULTS), MAX_RESULTS);
}

const SOURCE_FORMATS: readonly SourceFormat[] = ['uri', 'relative'];

/**
 * Validate `KnowledgeBaseOptions.sourceFormat`. Called by the mock and AWS constructors (and at
 * synth) so an unsupported value fails the same way everywhere.
 *
 * @param value - The caller-supplied option, or `undefined`/`null` for the default.
 * @returns `'uri'` when unset, otherwise the supplied value.
 * @throws {KnowledgeBaseValidationError} If `value` is set but not `'uri'` or `'relative'`.
 */
export function normalizeSourceFormat(value: unknown): SourceFormat {
	if (value === undefined || value === null) return 'uri';
	if (typeof value === 'string' && (SOURCE_FORMATS as readonly string[]).includes(value)) return value as SourceFormat;
	throw blocksError(
		KnowledgeBaseErrors.ValidationError,
		`sourceFormat must be one of ${SOURCE_FORMATS.map((f) => `'${f}'`).join(', ')}.`,
	);
}

/**
 * Turn a Bedrock `s3://<bucket>/<key>` location into the key relative to the knowledge base's
 * source root: the bucket is always dropped, and for an `s3://bucket/prefix` source the prefix is
 * dropped too (normalized with a trailing slash, the same way the data source's inclusion prefix
 * is). A folder source is deployed to the bucket root, so its key is already relative.
 *
 * Anything that is not an `s3://` URI with a key yields `''`, so the raw location never leaks.
 *
 * @param uri - The `s3Location.uri` Bedrock returned.
 * @param source - The knowledge base's configured `source`.
 * @returns The relative key, or `''`.
 */
export function relativeSourceKey(uri: string, source: string): string {
	if (!uri.startsWith('s3://')) return '';
	const slash = uri.indexOf('/', 's3://'.length);
	if (slash === -1) return '';
	const key = uri.slice(slash + 1);
	if (!source.startsWith('s3://')) return key;
	const sourceSlash = source.indexOf('/', 's3://'.length);
	const rawPrefix = sourceSlash === -1 ? '' : source.slice(sourceSlash + 1);
	if (!rawPrefix) return key;
	const prefix = rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;
	return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}
