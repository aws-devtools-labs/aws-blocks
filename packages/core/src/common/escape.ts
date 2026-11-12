// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Escapes every regular-expression metacharacter in `text`, so the result
 * matches `text` literally when placed inside a pattern.
 *
 * Use it for any value that isn't a pattern you wrote yourself (configuration,
 * a request header, a file name) before you build a `RegExp` around it.
 * Without it, `example.com` also matches `exampleXcom`, and `a|.*` matches
 * everything.
 *
 * The result is safe anywhere outside a character class (with or without the
 * `u` and `v` flags) and inside a character class without the `v` flag. A `-`
 * is written as `\x2d`, which every flag accepts.
 *
 * @param text - Literal text to embed in a regular expression.
 * @returns `text` with `\ ^ $ . * + ? ( ) [ ] { } | /` backslash-escaped and `-` as `\x2d`.
 *
 * @example
 * ```ts
 * import { escapeRegExp } from '@aws-blocks/core/bb-utils';
 *
 * const cookie = new RegExp(`(?:^|;\\s*)${escapeRegExp(name)}=([^;]+)`);
 * ```
 */
export function escapeRegExp(text: string): string {
	return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&').replaceAll('-', '\\x2d');
}

const HTML_ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
	'`': '&#96;',
};

/**
 * Escapes `value` for HTML text and for a quoted attribute value (`"…"` or `'…'`).
 *
 * Use it for every value that you interpolate into an HTML template literal
 * and that isn't markup you wrote yourself: a file path, an error message, a
 * user name, a value read from a request. Non-string values are converted with
 * `String(value)` first. The backtick isn't needed for those two contexts; it
 * is escaped defensively, because some old browsers accepted it as an
 * attribute-value quote.
 *
 * It does not make a value safe inside a `<script>` or `<style>` element, an
 * unquoted attribute, an event-handler attribute (`onclick`) or a URL
 * attribute (`href`, `src`); keep data out of those contexts.
 *
 * @param value - The value to place in HTML.
 * @returns The value as text with `& < > " ' \`` replaced by character references.
 *
 * @example
 * ```ts
 * import { escapeHtml } from '@aws-blocks/core/bb-utils';
 *
 * ctx.response.send(`<p>File location: <code>${escapeHtml(path)}</code></p>`);
 * ```
 */
export function escapeHtml(value: unknown): string {
	return String(value).replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]);
}
