// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Fails when a GitHub Actions `uses:` reference under .github/ isn't pinned to a
// full 40-character commit SHA. A mutable tag or branch (`@v7`, `@main`) lets
// whoever controls that ref run code inside our jobs — including the ones that
// assume an AWS deploy role via OIDC. Pin with a trailing version comment:
//
//   uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
//
// Dependabot (github-actions ecosystem) keeps pinned SHAs current.
// Local actions (`./...`) are out of scope. A `docker://` image must be pinned by
// digest (`docker://alpine@sha256:<64 hex>`), since an image tag is just as mutable.
//
// The scan is YAML-aware rather than a plain `uses:` regex: it finds the `uses` key
// whether it is written plain, single- or double-quoted (escapes decoded), or inside
// a flow mapping/sequence (`- { uses: … }`, `steps: [ … ]`), and decodes quoted
// values before checking them. It skips the bodies of `|`/`>` block scalars (`run:`
// scripts) and comments. It fails closed: any `uses` it cannot read off one line
// (value on the next line, block scalar, alias, tag, anchor, multi-line string,
// plain scalar that continues) and any key it cannot resolve (alias or tagged key,
// including a verbatim `!<…>` tag, explicit `?` key) is reported as a violation. Write `uses` the canonical way —
// `uses: owner/repo@<sha> # vX` on one line — and it passes.
//
// It uses Node built-ins only, so the guard itself installs no third-party code.
//
// Run: node scripts/check-actions-pinned.mjs   (exit 1 + list on violations)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PINNED = /@[0-9a-f]{40}$/;
const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;

// Start of a block node on a line: indentation plus any `- ` sequence indicators.
const LINE_START = /^[ \t]*(?:-(?:[ \t]+|$))*/;
// Node properties (`!tag`, verbatim `!<tag>`, `&anchor`) that may precede a key or value.
// The verbatim form is matched first because it may contain `,`.
const PROPS = /^(?:(?:!<[^>]*>|[!&][^\s,[\]{}]*)[ \t]+)*/;
const ALIAS_KEY = /^\*[^\s,[\]{}]+[ \t]*:(?=[\s,[\]{}]|$)/;
const DQ_KEY = /^"((?:[^"\\]|\\.)*)"[ \t]*:/;
const SQ_KEY = /^'((?:[^']|'')*)'[ \t]*:/;
const PLAIN_KEY = /^([^\s"'#,[\]{}:?*&!|>-][^#,[\]{}:]*?|-[^\s#,[\]{}:][^#,[\]{}:]*?)[ \t]*:(?=[\s,[\]{}]|$)/;
// A line that opens a `|` / `>` block scalar, optionally as the value of a key.
const BLOCK_HEADER =
	/^([ \t]*(?:-[ \t]+)*)(?:((?:[!&]\S*[ \t]+)*)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"?{[][^#]*?)[ \t]*:[ \t]+)?(?:[!&]\S*[ \t]+)*[|>][-+1-9]{0,2}[ \t]*(?:#.*)?$/;

const ESCAPES = {
	0: '\0',
	a: '\x07',
	b: '\b',
	t: '\t',
	'\t': '\t',
	n: '\n',
	v: '\v',
	f: '\f',
	r: '\r',
	e: '\x1b',
	' ': ' ',
	'"': '"',
	'/': '/',
	'\\': '\\',
	N: '\x85',
	_: '\xa0',
	L: '\u2028',
	P: '\u2029',
};
const HEX_LEN = { x: 2, u: 4, U: 8 };
const HEX_RE = { x: /^[0-9a-fA-F]{2}$/, u: /^[0-9a-fA-F]{4}$/, U: /^[0-9a-fA-F]{8}$/ };

/** Decode the body of a YAML double-quoted scalar; `null` if it uses an unknown escape. */
function decodeDouble(body) {
	let out = '';
	for (let i = 0; i < body.length; i++) {
		if (body[i] !== '\\') {
			out += body[i];
			continue;
		}
		const e = body[++i];
		if (e in HEX_LEN) {
			const hex = body.slice(i + 1, i + 1 + HEX_LEN[e]);
			if (!HEX_RE[e].test(hex)) return null;
			out += String.fromCodePoint(Number.parseInt(hex, 16));
			i += HEX_LEN[e];
		} else if (e in ESCAPES) out += ESCAPES[e];
		else return null;
	}
	return out;
}

/**
 * Read a `uses` value that starts at `ln[at]`. Returns `{ ref }` for a scalar fully on
 * this line, or `{ ref, reason }` when the value can't be read off this line.
 */
function readValue(lines, i, at, flow, keyCol) {
	const ln = lines[i];
	const s = ln.slice(at).replace(/^[ \t]+/, '');
	const raw = ln.trim();
	if (s === '' || s.startsWith('#')) return { ref: raw, reason: 'value is not on the same line as `uses`' };
	if (s[0] === '"') {
		const m = /^"((?:[^"\\]|\\.)*)"/.exec(s);
		const ref = m && decodeDouble(m[1]);
		return ref === null ? { ref: raw, reason: 'multi-line or undecodable quoted value' } : { ref };
	}
	if (s[0] === "'") {
		const m = /^'((?:[^']|'')*)'/.exec(s);
		return m ? { ref: m[1].replace(/''/g, "'") } : { ref: raw, reason: 'multi-line quoted value' };
	}
	if (/^[!&*|>{[@`%]/.test(s)) return { ref: raw, reason: 'value is an alias, anchor, tag, block or collection' };
	const m = (flow ? /^(.*?)(?=[ \t]#|[,\]}]|$)/ : /^(.*?)(?=[ \t]#|$)/).exec(s);
	const ref = m[1].trimEnd();
	if (m[1].length === s.length) {
		// A plain scalar at end of line continues onto any following, deeper-indented line.
		const next = lines.slice(i + 1).find((l) => !/^[ \t]*(#|$)/.test(l));
		if (next !== undefined && /^[ \t]*/.exec(next)[0].length > keyCol)
			return { ref: raw, reason: 'plain value continues on the next line' };
	}
	return { ref };
}

/** Find every `uses` key on one line (block or flow) and return its unpinned or unreadable values. */
function scanLine(lines, i) {
	const ln = lines[i];
	const starts = [{ at: LINE_START.exec(ln)[0].length, flow: false }];
	for (let j = 0; j < ln.length; j++) if ('{[,'.includes(ln[j])) starts.push({ at: j + 1, flow: true });
	const out = [];
	for (const { at, flow } of starts) {
		const ws = /^[ \t]*/.exec(ln.slice(at))[0].length;
		let pos = at + ws;
		let s = ln.slice(pos);
		if (/^\?(?=[ \t]|$)/.test(s)) {
			out.push({ ref: ln.trim(), reason: 'explicit `?` key' });
			continue;
		}
		const props = PROPS.exec(s)[0];
		pos += props.length;
		s = ln.slice(pos);
		if (ALIAS_KEY.test(s)) {
			out.push({ ref: ln.trim(), reason: 'alias used as a key' });
			continue;
		}
		const k = readKey(s);
		if (!k) continue;
		const { key, m } = k;
		if (props.includes('!')) {
			out.push({ ref: ln.trim(), reason: 'tagged key' });
			continue;
		}
		if (key.trim().toLowerCase() !== 'uses') continue;
		const v = readValue(lines, i, pos + m[0].length, flow, pos);
		if (v.reason || !isPinned(v.ref)) out.push(v);
	}
	return out;
}

/** Match a plain or quoted mapping key at the start of `s`; the key is decoded (undecodable reads as `uses`). */
function readKey(s) {
	const dq = DQ_KEY.exec(s);
	if (dq) return { key: decodeDouble(dq[1]) ?? 'uses', m: dq };
	const sq = SQ_KEY.exec(s);
	if (sq) return { key: sq[1].replace(/''/g, "'"), m: sq };
	const plain = PLAIN_KEY.exec(s);
	return plain ? { key: plain[1], m: plain } : null;
}

function isPinned(ref) {
	if (ref.startsWith('./')) return true;
	if (ref.startsWith('docker://')) return DIGEST_PINNED.test(ref);
	return PINNED.test(ref);
}

/** Column after which the lines of a block scalar opened on `ln` are indented, or -1. */
function blockScalarIndent(ln) {
	const m = BLOCK_HEADER.exec(ln);
	if (!m) return -1;
	if (m[3] !== undefined) return m[1].length + (m[2] ?? '').length;
	const dash = m[1].lastIndexOf('-');
	return dash >= 0 ? dash : m[1].length;
}

/**
 * Return `{ line, ref }` for every unpinned external `uses:` in a workflow/action file's
 * text. Entries the scan cannot read safely also carry a `reason` (see the file header).
 */
export function findUnpinned(text) {
	const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
	const out = [];
	let block = -1;
	for (let i = 0; i < lines.length; i++) {
		const ln = lines[i];
		if (block >= 0) {
			if (ln.trim() === '' || /^[ \t]*/.exec(ln)[0].length > block) continue;
			block = -1;
		}
		if (/^[ \t]*(#|$)/.test(ln)) continue;
		for (const v of scanLine(lines, i)) out.push({ line: i + 1, ...v });
		block = blockScalarIndent(ln);
	}
	return out;
}

function* yamlFiles(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) yield* yamlFiles(p);
		else if (/\.ya?ml$/.test(name)) yield p;
	}
}

/** Scan `<root>/.github` and return every violation as `{ file, line, ref }`. */
export function scan(root) {
	const violations = [];
	for (const file of yamlFiles(join(root, '.github'))) {
		for (const v of findUnpinned(readFileSync(file, 'utf8'))) violations.push({ file: relative(root, file), ...v });
	}
	return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
	const violations = scan(root);
	if (violations.length) {
		console.error(`✗ ${violations.length} GitHub Actions reference(s) not pinned to a commit SHA:\n`);
		for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.ref}${v.reason ? `  (${v.reason})` : ''}`);
		console.error(
			'\nPin each to a full 40-char SHA with a version comment, on one line as a plain or quoted scalar, e.g.' +
				'\n  uses: actions/checkout@<sha> # v7.0.1' +
				'\nPin a docker:// image by digest, e.g. uses: docker://alpine@sha256:<64-hex digest>',
		);
		process.exit(1);
	}
	console.log('✓ All GitHub Actions references are pinned to commit SHAs.');
}
