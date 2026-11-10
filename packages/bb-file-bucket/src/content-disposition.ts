// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { validationFailed } from './validation-error.js';

/**
 * Characters `encodeURIComponent` leaves unencoded that an RFC 5987 `ext-value`
 * (`attr-char`) does not allow, so they are percent-encoded on top of it.
 */
const RFC5987_EXTRA_ENCODE = /['()*]/g;

/** C0 controls, DEL and C1 controls — never valid in a header value. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Build the `Content-Disposition` value for a download URL's `attachment` option.
 *
 * - `undefined` / `false` → `undefined` (no override; the object is served with
 *   S3's default disposition).
 * - `true` → `attachment`.
 * - a filename → `attachment; filename="<ascii>"; filename*=UTF-8''<encoded>`
 *   (RFC 6266 with the RFC 5987 extended parameter). Control characters are
 *   removed from the name. In the quoted ASCII fallback, `"`, `\`, `%` and every
 *   non-ASCII character are replaced with `_`; the `filename*` parameter carries
 *   the full UTF-8 name, percent-encoded, for clients that support it.
 *
 * Shared by the mock and the AWS runtime so both produce the same header value.
 *
 * @param attachment - The `attachment` option from `getUrl()` / `getFileHandle()`.
 * @returns The header value, or `undefined` when no disposition is requested.
 * @throws {Error} `ValidationFailed` when `attachment` is not a boolean or a filename
 *   that is non-empty once control characters are removed.
 */
export function resolveContentDisposition(attachment: unknown): string | undefined {
	if (attachment === undefined || attachment === false) return undefined;
	if (attachment === true) return 'attachment';
	if (typeof attachment !== 'string') {
		throw validationFailed('Invalid attachment: must be a boolean or a filename');
	}
	// Drop lone surrogates (which `encodeURIComponent` can't encode) along with
	// control characters.
	const name = Array.from(attachment)
		.filter((ch) => {
			const code = ch.codePointAt(0) ?? 0;
			return !(code >= 0xd800 && code <= 0xdfff);
		})
		.join('')
		.replace(CONTROL_CHARS, '');
	if (name.trim() === '') {
		throw validationFailed('Invalid attachment: filename must not be empty');
	}
	const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
	const encoded = encodeURIComponent(name).replace(
		RFC5987_EXTRA_ENCODE,
		(ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
