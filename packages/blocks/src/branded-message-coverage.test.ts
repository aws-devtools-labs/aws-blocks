// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the self-tests scan TypeScript source held in plain strings.

/**
 * Regression guard: a branded Blocks error's MESSAGE must not be built from a
 * caught error's `.message`.
 *
 * Core forwards a branded error's `name` AND `message` to the RPC caller (see
 * `blocksError` / `brandBlocksError` / `sanitizeCaughtError` in `@aws-blocks/core`).
 * A raw driver/SDK/service message can embed account ids, ARNs, bucket names,
 * object keys or SQL, so interpolating it into the message of a branded error
 * re-opens the leak the brand was meant to close. The safe pattern is a stable,
 * BB-authored message with the raw error kept on a non-enumerable `cause`
 * (see `reTagged()` in `bb-database/src/errors.ts`).
 *
 * The scan flags every call to `blocksError(` / `coreBlocksError(` /
 * `brandBlocksError(` / `new ApiError(` whose arguments reference
 * `<identifier>.message` (including `a.b.message`, `a?.message` and
 * `(x as Error).message`) — interpolated, concatenated or passed directly — or a
 * local alias assigned from one on a single line (`const message = err.message`).
 * It also flags a `catch` binding stringified into the call (`${e}`, `String(e)`,
 * `e.toString()`). It deliberately does NOT match an indexed `issues[0].message`:
 * that is a Standard Schema issue describing the caller's own input, not a caught error.
 *
 * NOT covered (a backstop, not a proof; none of these are live in the repo today):
 * - destructured aliases (`const { message } = err`), declarations split across
 *   lines, and two-hop aliases (`const a = err.message; const b = a;`);
 * - alias and catch-binding scope: a `const message = x.message` (or a `catch (e)`)
 *   anywhere earlier in the file applies to every later call, even in another function;
 * - `String(x)` / `${x}` / `x.toString()` of a non-`catch` variable;
 * - regex literals (see {@link codeOnly}).
 *
 * Like `brand-coverage.test.ts`, this is a TEXT scan over `packages/<pkg>/src`
 * (tests, `.d.ts` and `dist` skipped), so it needs no runtime imports. Comments
 * and string-literal text are blanked before scanning. Intentional hits go in EXCEPTIONS with a reason.
 *
 * Run: node --test dist/branded-message-coverage.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagesDir = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'packages');

/** A known, reviewed hit: `call` is the FULL whitespace-collapsed call text. */
interface Exception {
	/** `<package>/<relative src path>`. */
	file: string;
	/** The whole call, whitespace collapsed, exactly as {@link findRawMessageHits} reports it. */
	call: string;
	/** How many identical calls the file has (default 1). A new copy makes the count test fail. */
	count?: number;
	reason: string;
}

/**
 * Known hits that are intentional or are being fixed elsewhere. Each entry
 * matches one exact call, so a NEW hit in an excepted file still fails.
 * Keep the list SHORT and prefer fixing the call site.
 */
const EXCEPTIONS: Exception[] = [
	{
		file: 'bb-auth/src/error-mapping.ts',
		call: 'new ApiError(message, e.status, { name: e.name, cause: e, ...(e.retriable ? { retriable: true } : {}) })',
		// Re-wraps an ApiError it caught; `message` is that error's own (already client-facing) text, scrubbed of AWS identifiers.
		reason: 're-wraps an existing ApiError with its message scrubbed',
	},
	{
		file: 'bb-data/src/errors.ts',
		call: 'new ApiError(entry.message, entry.status, { name: entry.name, cause })',
		// `entry` is a row of the constant REQUEST_ERRORS table, so its message is a stable BB string.
		reason: 'stable message from a constant table',
	},
	{
		file: 'bb-realtime/src/aws-middleware.ts',
		call: 'brandBlocksError(err)',
		// Client-side: re-raises a subscription rejection the realtime server sent; those messages are fixed BB strings.
		reason: 're-raises a fixed server rejection message',
	},
	{
		file: 'bb-realtime/src/mock-middleware.ts',
		call: 'brandBlocksError(err)',
		// Local dev twin of the aws-middleware rejection path above.
		reason: 're-raises a fixed server rejection message',
	},
	{
		file: 'bb-realtime/src/server-subscribe.ts',
		call: 'brandBlocksError(err)',
		// Server-side subscribe: same fixed rejection messages from the realtime WebSocket handler.
		reason: 're-raises a fixed server rejection message',
	},
	{
		file: 'core/src/rpc.ts',
		call: 'new ApiError(message, status)',
		// Client-side RPC decoder: rebuilds the error the server already serialized for this caller.
		reason: 'client-side decode of an already-sent error',
	},
	{
		file: 'core/src/rpc.ts',
		call: 'new ApiError( message, status, { ...(data?.name ? { name: data.name } : {}), ...(data?.retriable === true ? { retriable: true } : {}), }, )',
		// Same decoder; flagged only because aliases are not scoped (a `message` alias from another function).
		reason: 'client-side decode of an already-sent error',
	},
];

/** The EXCEPTIONS entry that excuses `hit` in file `key` (an exact call match), if any. */
function exceptionFor(key: string, hit: RawMessageHit): Exception | undefined {
	return EXCEPTIONS.find((e) => e.file === key && e.call === hit.call);
}

/** Recursively collect `*.ts` sources under `dir`, skipping tests, `.d.ts`, `dist`, `node_modules`. */
function collectSources(dir: string): string[] {
	const out: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf-8' });
	} catch {
		return out;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === 'dist' || e.name === 'node_modules') continue;
			out.push(...collectSources(p));
		} else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) {
			out.push(p);
		}
	}
	return out;
}

function discoverSrcDirs(): { pkg: string; srcDir: string }[] {
	const result: { pkg: string; srcDir: string }[] = [];
	for (const d of readdirSync(packagesDir, { withFileTypes: true, encoding: 'utf-8' })) {
		if (!d.isDirectory()) continue;
		const srcDir = join(packagesDir, d.name, 'src');
		try {
			if (statSync(srcDir).isDirectory()) result.push({ pkg: d.name, srcDir });
		} catch {}
	}
	return result;
}

/**
 * Return `src` with comment text and string/template literal text replaced by
 * spaces (newlines and quote characters kept, so offsets and line numbers are
 * unchanged). `${…}` expressions inside templates stay, since they are code.
 *
 * Regex literals are NOT recognized: a quote or backtick inside one (e.g. `/`/`)
 * is read as opening a string or template and blanks code up to the next match,
 * which can hide a later hit. Nothing under `packages/<pkg>/src` trips this today.
 */
export function codeOnly(src: string): string {
	const out = src.split('');
	const blank = (from: number, to: number) => {
		for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
	};
	// One entry per open template literal: -1 while in its text, else the `{` depth inside `${…}`.
	const templates: number[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const top = templates.length - 1;
		if (top >= 0 && templates[top] === -1) {
			if (c === '`') {
				templates.pop();
				i++;
				continue;
			}
			if (c === '$' && src[i + 1] === '{') {
				templates[top] = 0;
				i += 2;
				continue;
			}
			const step = c === '\\' ? 2 : 1;
			blank(i, i + step);
			i += step;
			continue;
		}
		if (c === '/' && src[i + 1] === '/') {
			const end = src.indexOf('\n', i);
			const stop = end === -1 ? src.length : end;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (c === '/' && src[i + 1] === '*') {
			const end = src.indexOf('*/', i + 2);
			const stop = end === -1 ? src.length : end + 2;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (c === "'" || c === '"') {
			let j = i + 1;
			while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
			blank(i + 1, Math.min(j, src.length));
			i = j + 1;
			continue;
		}
		if (c === '`') {
			templates.push(-1);
			i++;
			continue;
		}
		if (top >= 0 && c === '{') templates[top]++;
		else if (top >= 0 && c === '}') templates[top] = templates[top] === 0 ? -1 : templates[top] - 1;
		i++;
	}
	return out.join('');
}

/** Index of the `)` matching the `(` at `open` in {@link codeOnly} output, or -1. */
function matchParen(code: string, open: number): number {
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		if (code[i] === '(') depth++;
		else if (code[i] === ')' && --depth === 0) return i;
	}
	return -1;
}

/** A call that mints or brands a Blocks error (not its declaration: `function blocksError(` is skipped). */
const BRANDED_CALL =
	/(?<![\w$.])(?<!function\s+)(?:new\s+ApiError|blocksError|coreBlocksError|brandBlocksError)\s*(?:<[^()]*>\s*)?\(/g;

/** `<identifier>.message`, `a.b?.message`, or `(expr).message` — not `issues[0].message`. */
const RAW_MESSAGE = /(?:(?<![\w$.])[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*|\))\??\.message\b/;

export interface RawMessageHit {
	line: number;
	call: string;
}

/**
 * A one-line local declaration `const x = <rhs>` (optionally typed, `const x: string = <rhs>`);
 * `x` aliases a raw message when `<rhs>` matches {@link RAW_MESSAGE}.
 */
const DECLARATION = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:[^=;\n]+)?\s*=(?!=)([^;\n]*)/g;

/** A `catch (e)` binding: the caught value itself, whose string form is its raw message. */
const CATCH_BINDING = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g;

/** `${e}`, `String(e)` or `e.toString()` for one of `names`. */
function stringifyOf(names: string[]): RegExp | undefined {
	if (names.length === 0) return undefined;
	const n = `(?:${names.join('|')})`;
	return new RegExp(
		`\\$\\{\\s*${n}\\s*\\}|(?<![\\w$.])String\\(\\s*${n}\\s*\\)|(?<![\\w$.])${n}\\s*\\.\\s*toString\\s*\\(`,
	);
}

/**
 * Names whose most recent declaration before `offset` was assigned from a
 * `.message` (one level of indirection, e.g. `const message = err.message`).
 * A later re-declaration of the same name (`const err = new Error('stable')`)
 * clears it, so a reused variable name does not carry over.
 */
function rawAliasesAt(declarations: { name: string; index: number; raw: boolean }[], offset: number): string[] {
	const latest = new Map<string, boolean>();
	for (const d of declarations) if (d.index < offset) latest.set(d.name, d.raw);
	return [...latest].filter(([, raw]) => raw).map(([name]) => name);
}

/** Find branded-error calls in `src` whose arguments reference a `.message` (directly or via a local alias). */
export function findRawMessageHits(src: string): RawMessageHit[] {
	const code = codeOnly(src);
	const declarations = [...code.matchAll(DECLARATION)].map((m) => ({
		name: m[1],
		index: m.index ?? 0,
		raw: RAW_MESSAGE.test(m[2]),
	}));
	const catches = [...code.matchAll(CATCH_BINDING)].map((m) => ({ name: m[1], index: m.index ?? 0 }));
	const hits: RawMessageHit[] = [];
	for (const m of code.matchAll(BRANDED_CALL)) {
		const open = (m.index ?? 0) + m[0].length - 1;
		const close = matchParen(code, open);
		if (close === -1) continue;
		const args = code.slice(open + 1, close);
		const aliases = rawAliasesAt(declarations, m.index ?? 0);
		// A bare use of an alias: not a property access (`.x`), not an object key (`x:`).
		const aliasUse = aliases.length
			? new RegExp(`(?<![\\w$.])(?:${aliases.join('|')})(?![\\w$]|\\s*:)`)
			: undefined;
		const caught = [...new Set(catches.filter((c) => c.index < (m.index ?? 0)).map((c) => c.name))];
		if (!RAW_MESSAGE.test(args) && !aliasUse?.test(args) && !stringifyOf(caught)?.test(args)) continue;
		const line = code.slice(0, m.index).split('\n').length;
		hits.push({
			line,
			call: src
				.slice(m.index, close + 1)
				.replace(/\s+/g, ' ')
				.trim(),
		});
	}
	return hits;
}

test('no branded Blocks error builds its message from a caught error .message', () => {
	const offenders: string[] = [];
	for (const { pkg, srcDir } of discoverSrcDirs()) {
		for (const file of collectSources(srcDir)) {
			const key = `${pkg}/${file.slice(join(packagesDir, pkg).length + 1)}`;
			for (const hit of findRawMessageHits(readFileSync(file, 'utf-8'))) {
				if (exceptionFor(key, hit)) continue;
				offenders.push(`${key}:${hit.line}  ${hit.call}`);
			}
		}
	}
	assert.deepStrictEqual(
		offenders,
		[],
		`These calls build a branded Blocks error from a \`.message\`. A branded error's message crosses ` +
			`the RPC wire, so raw driver/SDK/service text (account ids, ARNs, bucket names, SQL) would reach ` +
			`the client.\n  ${offenders.join('\n  ')}\n\n` +
			`Use a stable message and keep the raw error on a non-enumerable \`cause\` ` +
			`(see reTagged() in bb-database/src/errors.ts), or add an EXCEPTIONS entry with a reason.`,
	);
});

test('every EXCEPTIONS entry matches exactly its expected number of hits', () => {
	const used = new Map<Exception, number>();
	for (const { pkg, srcDir } of discoverSrcDirs()) {
		for (const file of collectSources(srcDir)) {
			const key = `${pkg}/${file.slice(join(packagesDir, pkg).length + 1)}`;
			for (const hit of findRawMessageHits(readFileSync(file, 'utf-8'))) {
				const k = exceptionFor(key, hit);
				if (k) used.set(k, (used.get(k) ?? 0) + 1);
			}
		}
	}
	const mismatched = EXCEPTIONS.filter((e) => (used.get(e) ?? 0) !== (e.count ?? 1)).map(
		(e) => `${e.file}: expected ${e.count ?? 1}, found ${used.get(e) ?? 0}  ${e.call}`,
	);
	assert.deepStrictEqual(
		mismatched,
		[],
		`Update or remove these EXCEPTIONS entries (0 found = stale; more than expected = a new, unreviewed copy):\n  ${mismatched.join('\n  ')}`,
	);
});

test('guard self-test: flags raw .message in branded calls', () => {
	const bad = [
		'throw blocksError(Errs.Failed, `Query failed: ${err.message}`);',
		"throw blocksError(Errs.Failed, 'Query failed: ' + e.message);",
		'throw blocksError(Errs.Failed, error.message + " (retry)");',
		'throw coreBlocksError(name, err.message);',
		'throw new ApiError(`Upstream: ${caught?.message}`, 502);',
		'throw new ApiError(\n\t`Upstream: ${(e as Error).message}`,\n\t502,\n);',
		'return brandBlocksError(Object.assign(new Error(err.cause.message), { name: Errs.Failed }));',
		'throw blocksError(Errs.Failed, `a ${`nested ${x.message}`}`);',
		"const message = err.message ?? 'Unknown';\nreturn blocksError(Errs.Failed, message);",
		'const message: string = err.message;\nthrow blocksError(Errs.Failed, message);',
		'throw blocksError<string>(Errs.Failed, err.message);',
		'try { x(); } catch (e) { throw blocksError(Errs.Failed, `Failed: ${e}`); }',
		'try { x(); } catch (e) { throw blocksError(Errs.Failed, String(e)); }',
		'try { x(); } catch (err) { throw new ApiError(err.toString(), 502); }',
	];
	for (const snippet of bad) {
		assert.strictEqual(findRawMessageHits(snippet).length, 1, `expected a hit for: ${snippet}`);
	}
	assert.strictEqual(findRawMessageHits('\n\nthrow blocksError(E.X, e.message);')[0]?.line, 3);
});

test('guard self-test: passes stable messages, causes and non-call mentions', () => {
	const good = [
		"throw blocksError(Errs.Failed, 'Query failed.');",
		"const e = blocksError(Errs.Failed, 'Query failed.'); Object.defineProperty(e, 'cause', { value: err });",
		'throw blocksError(Errs.Failed, `Query failed (${err.name})`);',
		"throw new ApiError('Upstream failed', 502, { name: 'X', cause: err });",
		'throw blocksError(Errs.Invalid, resolved.issues[0].message);',
		"throw blocksError(Errs.Failed, 'see err.message in the logs');",
		'throw blocksError(Errs.Failed, `literal text: err.message`);',
		'// throw blocksError(Errs.Failed, err.message);',
		'/* blocksError(Errs.Failed, `${err.message}`) */ log.error(err.message);',
		'export function blocksError(name: string, message: string): Error { return mint(name, message); }',
		'log.error(err.message); throw blocksError(Errs.Failed, "stable");',
		"const message = err.message;\nlog.error(message);\nthrow blocksError(Errs.Failed, 'stable', { message: 1 });",
		"const err = new Error(e.message);\nlog.error(err);\nconst err = new Error('stable');\nthrow brandBlocksError(err);",
		"const message: string = 'stable';\nthrow blocksError(Errs.Failed, message);",
		'try { x(); } catch (e) { throw blocksError(Errs.Failed, `Failed (${e.name})`); }',
		'try { x(); } catch (e) { log.error(String(e)); throw blocksError(Errs.Failed, String(code)); }',
	];
	for (const snippet of good) {
		assert.deepStrictEqual(findRawMessageHits(snippet), [], `expected no hit for: ${snippet}`);
	}
});

test('branded-message discovery sanity check', () => {
	const found = discoverSrcDirs().map((d) => d.pkg);
	assert.ok(found.includes('core') && found.filter((p) => p.startsWith('bb-')).length >= 8, `found ${found}`);
});
