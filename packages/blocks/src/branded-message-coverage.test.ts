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
 * It deliberately does NOT match an indexed `issues[0].message`: that is a
 * Standard Schema issue describing the caller's own input, not a caught error.
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

/**
 * Known hits that are intentional or are being fixed elsewhere, keyed by
 * `<package>/<relative src path>:<substring of the whitespace-collapsed call>`,
 * each with a reason. Keep the list SHORT and prefer fixing the call site.
 */
const EXCEPTIONS: Record<string, string> = {
	// Re-throws an ApiError it caught with only `retriable` changed; that message was already client-facing.
	'bb-auth-cognito/src/index.ts:new ApiError(e.message, e.status': 're-wraps an existing ApiError unchanged',
	// `entry` is a row of the constant REQUEST_ERRORS table, so its message is a stable BB string.
	'bb-data/src/errors.ts:new ApiError(entry.message': 'stable message from a constant table',
	// mapSesError forwards the raw SES message; a separate open change replaces it with stable messages.
	'bb-email-client/src/index.aws.ts:, message)': 'fix in flight in a separate change',
	// Client-side: re-raises a subscription rejection the realtime server sent; those messages are fixed BB strings.
	'bb-realtime/src/aws-middleware.ts:brandBlocksError(err)': 're-raises a fixed server rejection message',
	// Local dev twin of the aws-middleware rejection path above.
	'bb-realtime/src/mock-middleware.ts:brandBlocksError(err)': 're-raises a fixed server rejection message',
	// Server-side subscribe: same fixed rejection messages from the realtime WebSocket handler.
	'bb-realtime/src/server-subscribe.ts:brandBlocksError(err)': 're-raises a fixed server rejection message',
	// Client-side RPC decoder: rebuilds the error the server already serialized for this caller.
	'core/src/rpc.ts:message, status': 'client-side decode of an already-sent error',
};

/** The EXCEPTIONS key that excuses `hit` in file `key`, if any. */
function exceptionFor(key: string, hit: RawMessageHit): string | undefined {
	return Object.keys(EXCEPTIONS).find((k) => k.startsWith(`${key}:`) && hit.call.includes(k.slice(key.length + 1)));
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
const BRANDED_CALL = /(?<![\w$.])(?<!function\s+)(?:new\s+ApiError|blocksError|coreBlocksError|brandBlocksError)\s*\(/g;

/** `<identifier>.message`, `a.b?.message`, or `(expr).message` — not `issues[0].message`. */
const RAW_MESSAGE = /(?:(?<![\w$.])[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*|\))\??\.message\b/;

export interface RawMessageHit {
	line: number;
	call: string;
}

/** A one-line local declaration `const x = <rhs>`; `x` aliases a raw message when `<rhs>` matches {@link RAW_MESSAGE}. */
const DECLARATION = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=([^;\n]*)/g;

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
		if (!RAW_MESSAGE.test(args) && !aliasUse?.test(args)) continue;
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

test('every EXCEPTIONS entry still matches a current hit', () => {
	const used = new Set<string>();
	for (const { pkg, srcDir } of discoverSrcDirs()) {
		for (const file of collectSources(srcDir)) {
			const key = `${pkg}/${file.slice(join(packagesDir, pkg).length + 1)}`;
			for (const hit of findRawMessageHits(readFileSync(file, 'utf-8'))) {
				const k = exceptionFor(key, hit);
				if (k) used.add(k);
			}
		}
	}
	const stale = Object.keys(EXCEPTIONS).filter((k) => !used.has(k));
	assert.deepStrictEqual(stale, [], `Remove these stale EXCEPTIONS entries:\n  ${stale.join('\n  ')}`);
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
	];
	for (const snippet of good) {
		assert.deepStrictEqual(findRawMessageHits(snippet), [], `expected no hit for: ${snippet}`);
	}
});

test('branded-message discovery sanity check', () => {
	const found = discoverSrcDirs().map((d) => d.pkg);
	assert.ok(found.includes('core') && found.filter((p) => p.startsWith('bb-')).length >= 8, `found ${found}`);
});
