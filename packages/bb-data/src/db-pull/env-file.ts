// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Surgical `.env` updates for `db pull`. The env files it touches (`.env.local`,
 * `.env.production`) are shared with the rest of the app — AWS profile, OIDC
 * secrets, anything the developer put there — and are usually gitignored, so a
 * clobbered value can't be recovered. These helpers change only the one entry
 * `db pull` owns and leave every other byte of the file as it was.
 *
 * The format is the one `@aws-blocks/core` reads with `process.loadEnvFile()`
 * (Node's built-in dotenv parser, also exposed as `util.parseEnv()`), so every
 * edit is checked against that parser before anything is written.
 *
 * @module
 */
import * as fs from 'node:fs';
import { parseEnv } from 'node:util';

const QUOTES = ['"', "'", '`'] as const;

/**
 * Serialize `value` so Node's dotenv parser reads it back verbatim. Values that
 * need no quoting are written bare (the form every other `.env` reader in the
 * framework understands); otherwise the first quote style that preserves the
 * value literally is used. Throws for values no single-line form can represent.
 */
export function formatEnvValue(value: string): string {
	if (/[\r\n]/.test(value)) {
		throw new Error('Env values must be a single line.');
	}
	// Bare: no inline-comment marker, no surrounding whitespace, no leading quote.
	if (!value.includes('#') && value === value.trim() && !QUOTES.some((q) => value.startsWith(q))) {
		return value;
	}
	// Single quotes and backticks are literal; double quotes expand `\n`.
	if (!value.includes("'")) return `'${value}'`;
	if (!value.includes('"') && !value.includes('\\n')) return `"${value}"`;
	if (!value.includes('`')) return `\`${value}\``;
	throw new Error('Env value contains every quote character and cannot be written safely.');
}

/** Split into physical lines, each keeping its own terminator (`\n`, `\r\n`, or none). */
function splitLines(body: string): string[] {
	const lines: string[] = [];
	let start = 0;
	while (start < body.length) {
		const nl = body.indexOf('\n', start);
		const end = nl === -1 ? body.length : nl + 1;
		lines.push(body.slice(start, end));
		start = end;
	}
	return lines;
}

function splitTerminator(line: string): { text: string; eol: string } {
	const m = /\r?\n$/.exec(line);
	return m ? { text: line.slice(0, m.index), eol: m[0] } : { text: line, eol: '' };
}

/**
 * Index of the line holding the closing `quote` of a value that opened on line
 * `from` without closing there, or `from` when the quote never closes (Node then
 * reads the rest of the opening line as the value).
 */
function closingQuoteLine(lines: string[], from: number, quote: string): number {
	for (let j = from + 1; j < lines.length; j++) {
		if (lines[j].includes(quote)) return j;
	}
	return from;
}

/**
 * Return `content` with `key` set to `value`, changing nothing else.
 *
 * - Every existing assignment of `key` (including `export KEY=` forms and quoted,
 *   multi-line values) is rewritten in place as one line: the text up to and
 *   including `=` (indentation, `export` prefix, spacing before `=`) and the line
 *   ending are kept, and everything after `=` is replaced by the new value. That
 *   line is owned outright, so a trailing `# comment` on it is not kept: in an
 *   unquoted value Node treats any `#` as a comment start, so a comment can't be
 *   told apart from the tail of an old value that contained `#`. A line
 *   counts as an assignment of `key` only when Node's parser reads it as one:
 *   `export KEY=` with an empty value is read as the separate key `export KEY`,
 *   so it is left alone.
 * - When `key` is absent, `KEY=value` is appended using the file's line ending
 *   (CRLF if the file uses it), first terminating a final line that lacks a newline.
 *   If the file ends with an assignment whose value is only whitespace (`A= `),
 *   Node would read the appended line as that value, so a `#` comment line is
 *   inserted first to end it.
 * - Comments, blank lines, other keys (duplicates included) and untouched line
 *   endings are preserved byte-for-byte. A leading BOM is kept as-is; Node's
 *   parser does not strip it, so it is treated as part of the first line's key,
 *   exactly as `process.loadEnvFile` would read it.
 *
 * The result is verified with Node's dotenv parser (`util.parseEnv`, what
 * `process.loadEnvFile` uses): every other key must parse exactly as before and
 * `key` must parse to `value`. Otherwise this throws instead of returning a file
 * the app would read differently.
 */
export function upsertEnvContent(content: string, key: string, value: string): string {
	const formatted = formatEnvValue(value);
	const lines = splitLines(content);

	const assignment = /^[ \t]*(?:export [ \t]*)?[^ \t#=][^=]*=[ \t]*(["'`])(.*)$/;
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const own = new RegExp(`^[ \\t]*(?:export [ \\t]*)?${escapedKey}[ \\t]*=`);

	const out: string[] = [];
	let found = false;
	for (let i = 0; i < lines.length; i++) {
		const { text } = splitTerminator(lines[i]);
		const mine = own.exec(text);
		const quoted = assignment.exec(text);
		// A quoted value whose closing quote is on a later line spans those lines.
		let last = i;
		if (quoted && !quoted[2].includes(quoted[1])) last = closingQuoteLine(lines, i, quoted[1]);

		// The regex is a quick filter; Node's parser decides whether the line (or the
		// quoted value it opens) really assigns `key`.
		if (!mine || !Object.hasOwn(parseEnv(lines.slice(i, last + 1).join('')), key)) {
			for (let j = i; j <= last; j++) out.push(lines[j]);
			i = last;
			continue;
		}

		found = true;
		out.push(`${mine[0]}${formatted}${splitTerminator(lines[last]).eol}`);
		i = last;
	}

	if (!found) {
		const eol = content.includes('\r\n') ? '\r\n' : '\n';
		const last = out.length > 0 ? out[out.length - 1] : '';
		if (last !== '' && !last.endsWith('\n')) out[out.length - 1] = last + eol;
		const line = `${key}=${formatted}${eol}`;
		if (parseEnv(out.join('') + line)[key] !== value) out.push(`#${eol}`);
		out.push(line);
	}

	const result = out.join('');
	assertOnlyKeyChanged(content, result, key, value);
	return result;
}

function assertOnlyKeyChanged(before: string, after: string, key: string, value: string): void {
	const was = parseEnv(before);
	const now = parseEnv(after);
	const keys = new Set([...Object.keys(was), ...Object.keys(now)]);
	keys.delete(key);
	const changed = [...keys].filter((k) => was[k] !== now[k]);
	if (now[key] !== value || changed.length > 0) {
		throw new Error(
			`Could not update ${key} without changing how other entries are read` +
				(changed.length > 0 ? ` (${changed.join(', ')})` : '') +
				`. Set ${key} in this file by hand.`,
		);
	}
}

/**
 * Read the env file at `filePath` as text, or `null` when it doesn't exist.
 * Throws for any other read error, and for content that isn't valid UTF-8
 * (decoding would replace the bad bytes, and writing that back would corrupt them).
 */
export function readEnvFile(filePath: string): string | null {
	let raw: Buffer;
	try {
		raw = fs.readFileSync(filePath);
	} catch (e: unknown) {
		if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return null;
		throw e;
	}
	const text = raw.toString('utf-8');
	if (!Buffer.from(text, 'utf-8').equals(raw)) {
		throw new Error(`${filePath} is not valid UTF-8. Edit it by hand.`);
	}
	return text;
}

/**
 * Read the env file at `filePath` and compute it with `key` set to `value`
 * ({@link readEnvFile} + {@link upsertEnvContent}), without writing anything.
 * Throws exactly the content errors {@link upsertEnvFile} would, prefixed with
 * the path, so a caller can check that an update will go through before doing
 * other work. `original` is `null` when the file doesn't exist.
 */
export function prepareEnvFileUpsert(
	filePath: string,
	key: string,
	value: string,
): { original: string | null; next: string } {
	const original = readEnvFile(filePath);
	try {
		return { original, next: upsertEnvContent(original ?? '', key, value) };
	} catch (e: unknown) {
		throw new Error(`${filePath}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/**
 * Set `key` to `value` in the env file at `filePath`, preserving everything else
 * in it (see {@link upsertEnvContent}). Creates the file when missing. The file is
 * rewritten in place, so it keeps its inode and with it its permission bits (e.g.
 * `0600`), owner, group and ACLs; a read-only file is refused (`EACCES`) rather
 * than replaced. A symlinked env file is updated at its target (a dangling link's
 * target is created). Returns whether the file was created.
 *
 * The file is read fresh on every call (see {@link prepareEnvFileUpsert}), so a
 * check made earlier doesn't pin stale content.
 */
export function upsertEnvFile(filePath: string, key: string, value: string): { created: boolean } {
	const { original, next } = prepareEnvFileUpsert(filePath, key, value);
	if (next !== original) fs.writeFileSync(filePath, next);
	return { created: original === null };
}
