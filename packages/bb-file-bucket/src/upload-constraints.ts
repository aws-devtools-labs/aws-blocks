// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Upload constraints shared by the mock and the AWS runtime.
 *
 * `put()`, `putUrl()` and `createUploadHandle()` resolve the effective content
 * type and size through these helpers in BOTH runtimes, so an upload accepted
 * (or rejected) locally is accepted (or rejected) identically on AWS:
 * - a presigned upload always signs a `Content-Type` — the caller's, or
 *   {@link DEFAULT_UPLOAD_CONTENT_TYPE} when omitted — so the uploader cannot
 *   choose a different one;
 * - `allowedContentTypes` restricts the content types a bucket accepts;
 * - `contentLength` signs an exact upload size, and `maxUploadBytes` caps it.
 *
 * Request-input rejections throw `ValidationFailed` (HTTP 400, see
 * `validation-error.ts`) with static messages. Bucket-option rejections at
 * construction throw a plain `Error`, matching the other option guards in
 * `validation.ts`.
 */

import type { FileBucketOptions, PutUrlOptions } from './types.js';
import { validationFailed } from './validation-error.js';

/** Content type signed into a presigned upload, and stored by `put()`, when the caller passes none. */
export const DEFAULT_UPLOAD_CONTENT_TYPE = 'application/octet-stream';

/**
 * An `allowedContentTypes` entry: a `type/subtype` media type or a `type/*`
 * wildcard, using the RFC 9110 token characters. Parameters (`; charset=…`) are
 * not part of an entry — matching compares the media type without them.
 */
const CONTENT_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/i;

/** The constraint options a bucket enforces on uploads, normalized once at construction. */
export interface UploadConstraints {
	/** Lowercased `allowedContentTypes` entries, or `undefined` when any content type is accepted. */
	readonly allowedContentTypes?: readonly string[];
	/** The `maxUploadBytes` cap, or `undefined` when uploads are not size-capped. */
	readonly maxUploadBytes?: number;
}

/** The effective values a presigned upload is signed with. */
export interface ResolvedPresignedUpload {
	/** The content type the upload must send (always signed). */
	readonly contentType: string;
	/** The exact byte size the upload must send, when one was signed. */
	readonly contentLength?: number;
}

/**
 * Validate the shape of `allowedContentTypes` and `maxUploadBytes` at
 * construction. Called by `validateFileBucketOptions` (CDK synth and the mock),
 * by the external-bucket branches of both, and by the AWS runtime constructor,
 * so a malformed option fails the same way on every layer.
 *
 * @param fullId - The bucket's scope-derived id, used in error messages.
 * @param options - The FileBucket options to validate.
 * @throws {Error} When `allowedContentTypes` is not a non-empty array of
 *   `type/subtype` or `type/*` strings, or `maxUploadBytes` is not a positive safe integer.
 */
export function validateUploadConstraintOptions(fullId: string, options?: FileBucketOptions): void {
	const allowed = options?.allowedContentTypes;
	if (allowed !== undefined) {
		if (!Array.isArray(allowed) || allowed.length === 0) {
			throw new Error(
				`FileBucket "${fullId}": allowedContentTypes must be a non-empty array of content types ` +
					`(e.g. ['image/png', 'image/*']). Omit it to accept any content type.`,
			);
		}
		for (const entry of allowed) {
			if (typeof entry !== 'string' || !CONTENT_TYPE_PATTERN.test(entry)) {
				throw new Error(
					`FileBucket "${fullId}": allowedContentTypes entries must be 'type/subtype' or 'type/*' strings ` +
						`without parameters (got ${JSON.stringify(entry)}).`,
				);
			}
		}
	}
	const max = options?.maxUploadBytes;
	if (max !== undefined && (!Number.isSafeInteger(max) || max <= 0)) {
		throw new Error(`FileBucket "${fullId}": maxUploadBytes must be a positive integer (got ${String(max)}).`);
	}
}

/**
 * Normalize the upload-constraint options once, at construction.
 *
 * @param options - The FileBucket options (already validated).
 */
export function uploadConstraintsFrom(options?: FileBucketOptions): UploadConstraints {
	return {
		...(options?.allowedContentTypes
			? { allowedContentTypes: Object.freeze(options.allowedContentTypes.map((t) => t.toLowerCase())) }
			: {}),
		...(options?.maxUploadBytes !== undefined ? { maxUploadBytes: options.maxUploadBytes } : {}),
	};
}

/** An RFC 9110 `token` (`tchar`s only). */
const TOKEN = String.raw`[!#$%&'*+.^_\`|~0-9A-Za-z-]+`;
/**
 * An RFC 9110 `quoted-string`, ASCII only: `qdtext` (tab, space and visible
 * characters other than `"` and `\`) or a `\`-escaped tab, space or visible character.
 */
const QUOTED_STRING = String.raw`"(?:[\t \x21\x23-\x5b\x5d-\x7e]|\\[\t \x21-\x7e])*"`;
/** Optional whitespace (spaces and tabs). */
const OWS = String.raw`[ \t]*`;

/**
 * A complete `Content-Type` value an upload accepts: `type/subtype` followed by
 * zero or more `; name=value` parameters, where the value is a token or a quoted
 * string, with optional whitespace around `;` and `=`. Anything else — a comma
 * outside a quoted string (a list of types), non-ASCII or control characters,
 * an empty or dangling parameter — does not match. Captures the type and subtype.
 */
const UPLOAD_CONTENT_TYPE = new RegExp(
	`^(${TOKEN})/(${TOKEN})(?:${OWS};${OWS}${TOKEN}${OWS}=${OWS}(?:${TOKEN}|${QUOTED_STRING}))*$`,
);

/**
 * Parse a caller-supplied `Content-Type` against {@link UPLOAD_CONTENT_TYPE}.
 *
 * @returns The lowercased type and subtype, or `undefined` when the whole value
 *   is not a single well-formed media type.
 */
function parseUploadContentType(contentType: string): { type: string; subtype: string } | undefined {
	const match = UPLOAD_CONTENT_TYPE.exec(contentType);
	if (!match) return undefined;
	return { type: match[1].toLowerCase(), subtype: match[2].toLowerCase() };
}

/**
 * True when the parsed media type matches an exact `type/subtype` entry, or a
 * `type/*` entry whose type part is exactly the parsed type.
 */
function isAllowedMediaType(allowed: readonly string[], mediaType: { type: string; subtype: string }): boolean {
	return allowed.some((entry) =>
		entry.endsWith('/*')
			? entry.slice(0, -2) === mediaType.type
			: entry === `${mediaType.type}/${mediaType.subtype}`,
	);
}

/**
 * Resolve the content type an upload uses — the caller's, or
 * {@link DEFAULT_UPLOAD_CONTENT_TYPE} when omitted — validate it, and check it
 * against `allowedContentTypes`.
 *
 * The WHOLE caller-supplied value must be a single well-formed media type
 * (`type/subtype` plus optional `; name=value` parameters, ASCII only, no comma
 * outside a quoted string), whether or not the bucket sets
 * `allowedContentTypes`: the value is signed and stored unchanged, so it must be
 * exactly what was matched. Matching then ignores case and parameters:
 * `text/plain; charset=utf-8` matches an entry `text/plain` or `text/*`.
 *
 * @param constraints - The bucket's upload constraints.
 * @param contentType - The caller-supplied content type, if any.
 * @returns The effective content type (the caller's string unchanged, parameters included).
 * @throws {Error} `ValidationFailed` when the value is not a string, is not a single
 *   well-formed media type, or is not in `allowedContentTypes`.
 */
export function resolveUploadContentType(constraints: UploadConstraints, contentType: unknown): string {
	if (contentType !== undefined && typeof contentType !== 'string') {
		throw validationFailed('Invalid contentType: must be a non-empty string');
	}
	const effective = contentType ?? DEFAULT_UPLOAD_CONTENT_TYPE;
	const mediaType = parseUploadContentType(effective);
	if (!mediaType) {
		throw validationFailed('Invalid contentType: must be a single type/subtype media type with optional parameters');
	}
	if (constraints.allowedContentTypes && !isAllowedMediaType(constraints.allowedContentTypes, mediaType)) {
		throw validationFailed('The content type is not allowed for this bucket');
	}
	return effective;
}

/**
 * Resolve the values a presigned upload (`putUrl()` / `createUploadHandle()`)
 * is signed with, enforcing the bucket's upload constraints.
 *
 * @param constraints - The bucket's upload constraints.
 * @param options - The caller's presigned upload options.
 * @returns The content type to sign (always present) and the content length to sign (when given).
 * @throws {Error} `ValidationFailed` when the content type is invalid or not allowed,
 *   `contentLength` is not a non-negative safe integer, `contentLength` is
 *   missing while `maxUploadBytes` is set, or `contentLength` exceeds `maxUploadBytes`.
 */
export function resolvePresignedUpload(
	constraints: UploadConstraints,
	options?: PutUrlOptions,
): ResolvedPresignedUpload {
	const contentType = resolveUploadContentType(constraints, options?.contentType);
	const contentLength: unknown = options?.contentLength;
	if (
		contentLength !== undefined &&
		(typeof contentLength !== 'number' || !Number.isSafeInteger(contentLength) || contentLength < 0)
	) {
		throw validationFailed('Invalid contentLength: must be a non-negative integer');
	}
	if (constraints.maxUploadBytes !== undefined) {
		if (contentLength === undefined) {
			throw validationFailed('contentLength is required because this bucket sets maxUploadBytes');
		}
		if ((contentLength as number) > constraints.maxUploadBytes) {
			throw validationFailed('The upload exceeds the maximum size allowed for this bucket');
		}
	}
	return { contentType, ...(contentLength !== undefined ? { contentLength: contentLength as number } : {}) };
}

/**
 * Resolve and check the content type and size of a server-side `put()`.
 *
 * @param constraints - The bucket's upload constraints.
 * @param contentType - The caller-supplied content type, if any.
 * @param byteLength - The body size in bytes.
 * @returns The effective content type to store.
 * @throws {Error} `ValidationFailed` when the content type is invalid or not allowed,
 *   or the body is larger than `maxUploadBytes`.
 */
export function resolvePutUpload(constraints: UploadConstraints, contentType: unknown, byteLength: number): string {
	const effective = resolveUploadContentType(constraints, contentType);
	if (constraints.maxUploadBytes !== undefined && byteLength > constraints.maxUploadBytes) {
		throw validationFailed('The upload exceeds the maximum size allowed for this bucket');
	}
	return effective;
}
