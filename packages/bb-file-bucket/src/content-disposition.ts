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
 * True for a formatting character removed from a download filename: the
 * bidirectional embedding/override (U+202A–U+202E) and isolate (U+2066–U+2069)
 * characters that key validation also rejects, plus the directional marks
 * U+200E (LRM), U+200F (RLM) and U+061C (ALM), and the zero-width characters
 * U+200B–U+200D (ZWSP, ZWNJ, ZWJ) and U+FEFF (BOM / ZWNBSP). Each changes how
 * the name is displayed, or is not visible in it.
 */
function isDroppedFormatChar(code: number): boolean {
	return (
		(code >= 0x202a && code <= 0x202e) ||
		(code >= 0x2066 && code <= 0x2069) ||
		code === 0x200e ||
		code === 0x200f ||
		code === 0x061c ||
		(code >= 0x200b && code <= 0x200d) ||
		code === 0xfeff
	);
}

/** Path separators, replaced with `_` so the filename is a single path component. */
const PATH_SEPARATORS = /[/\\]/g;

/**
 * Build the `Content-Disposition` value for a download URL's `attachment` option.
 *
 * - `undefined` / `false` → `undefined` (no override; the object is served with
 *   S3's default disposition).
 * - `true` → `attachment`.
 * - a filename → `attachment; filename="<ascii>"; filename*=UTF-8''<encoded>`
 *   (RFC 6266 with the RFC 5987 extended parameter). Control characters and
 *   the {@link isDroppedFormatChar} formatting characters are removed from the
 *   name, and `/` and `\` are replaced with `_` in both parameters, so the
 *   saved file name is a single path component that displays as the characters
 *   it contains. In the quoted ASCII fallback, `"`, `\`, `%` and every
 *   non-ASCII character are replaced with `_`; the `filename*` parameter carries
 *   the full UTF-8 name, percent-encoded, for clients that support it.
 *
 * Shared by the mock and the AWS runtime so both produce the same header value.
 *
 * @param attachment - The `attachment` option from `getUrl()` / `getFileHandle()`.
 * @returns The header value, or `undefined` when no disposition is requested.
 * @throws {Error} `ValidationFailed` when `attachment` is not a boolean or a filename
 *   that is non-empty once control and formatting characters are removed, or
 *   when that filename trims to `.` or `..`.
 */
export function resolveContentDisposition(attachment: unknown): string | undefined {
	if (attachment === undefined || attachment === false) return undefined;
	if (attachment === true) return 'attachment';
	if (typeof attachment !== 'string') {
		throw validationFailed('Invalid attachment: must be a boolean or a filename');
	}
	// Drop lone surrogates (which `encodeURIComponent` can't encode) and
	// formatting characters along with control characters, then replace path
	// separators.
	const name = Array.from(attachment)
		.filter((ch) => {
			const code = ch.codePointAt(0) ?? 0;
			return !(code >= 0xd800 && code <= 0xdfff) && !isDroppedFormatChar(code);
		})
		.join('')
		.replace(CONTROL_CHARS, '')
		.replace(PATH_SEPARATORS, '_');
	// `.` and `..` name a directory rather than a file, so they are rejected
	// like an empty name.
	const trimmed = name.trim();
	if (trimmed === '' || trimmed === '.' || trimmed === '..') {
		throw validationFailed('Invalid attachment: filename must not be empty, "." or ".."');
	}
	const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
	const encoded = encodeURIComponent(name).replace(
		RFC5987_EXTRA_ENCODE,
		(ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
