// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Detectors for the injection sinks the repo guards in scripts/sink-guards/*.test.mjs:
// a value interpolated into a regular expression, a shell command, a GitHub
// Actions `run:` script, generated Kotlin/Swift/Dart source, or HTML.
//
// Each detector returns `{ file, line, kind, text }` sites. A site is a
// place where a value that isn't a compile-time constant reaches the sink
// without passing through that sink's escape helper. The tests fail on any
// site that isn't in their allowlist, and on any allowlist entry that no
// longer matches a site (so the allowlist tightens as sites get fixed).
//
// TypeScript/JavaScript sinks are found on the TypeScript compiler's AST (the
// root `typescript` devDependency); workflow sinks on the parsed YAML (the root
// `yaml` devDependency); codegen sinks with line regexes over the generator
// sources, since there is no Kotlin/Swift/Dart parser in the Node toolchain.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;

/**
 * Production source files tracked by git: TypeScript and JavaScript outside
 * `node_modules`/`dist`, declaration files, and tests. Tests are out of scope:
 * they build regexes and commands from their own fixtures, and nothing they
 * build ships.
 */
export function listSourceFiles() {
	const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	return out
		.split('\0')
		.filter((f) => SOURCE_EXT.test(f))
		.filter((f) => !/(?:^|\/)(?:node_modules|dist)\//.test(f))
		.filter((f) => !f.endsWith('.d.ts'))
		.filter((f) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f))
		.filter((f) => !/(?:^|\/)(?:test|tests|__tests__|codegen-fixtures)\//.test(f));
}

/** Parses `text` as TypeScript/JavaScript (JSX allowed by extension). */
export function parseSource(file, text) {
	const kind = /\.[cm]?tsx$|\.jsx$/.test(file)
		? ts.ScriptKind.TSX
		: /\.[cm]?js$/.test(file)
			? ts.ScriptKind.JS
			: ts.ScriptKind.TS;
	return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

function lineOf(sf, node) {
	return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function snippet(sf, node) {
	return node.getText(sf).replace(/\s+/g, ' ').slice(0, 120);
}

function walk(node, visit) {
	visit(node);
	ts.forEachChild(node, (child) => walk(child, visit));
}

function bindingNames(name, out = []) {
	if (ts.isIdentifier(name)) out.push(name.text);
	else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
		for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
	}
	return out;
}

function declarationInList(list, name) {
	for (const decl of list.declarations) {
		if (!bindingNames(decl.name).includes(name)) continue;
		const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
		if (isConst && ts.isIdentifier(decl.name) && decl.initializer) return { kind: 'const', init: decl.initializer };
		if (isConst && ts.isIdentifier(decl.name) && ts.isForOfStatement(list.parent)) return { kind: 'for-of', of: list.parent.expression };
		return { kind: 'other' };
	}
	return undefined;
}

/** The declaration `name` refers to at `node`, found through the enclosing scopes. */
function resolve(node, name) {
	for (let scope = node.parent; scope; scope = scope.parent) {
		if (ts.isFunctionLike(scope)) {
			for (const p of scope.parameters ?? []) if (bindingNames(p.name).includes(name)) return { kind: 'other' };
			if (scope.name && ts.isIdentifier(scope.name) && scope.name.text === name && !ts.isFunctionDeclaration(scope)) {
				return { kind: 'function', fn: scope };
			}
		}
		if ((ts.isForOfStatement(scope) || ts.isForInStatement(scope) || ts.isForStatement(scope)) && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
			const d = declarationInList(scope.initializer, name);
			if (d) return ts.isForInStatement(scope) ? { kind: 'other' } : d;
		}
		if (ts.isCatchClause(scope) && scope.variableDeclaration && bindingNames(scope.variableDeclaration.name).includes(name)) {
			return { kind: 'other' };
		}
		const statements = ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) ? scope.statements : ts.isCaseClause(scope) || ts.isDefaultClause(scope) ? scope.statements : undefined;
		if (!statements) continue;
		for (const st of statements) {
			if (ts.isVariableStatement(st)) {
				const d = declarationInList(st.declarationList, name);
				if (d) return d;
			}
			if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name?.text === name) {
				return ts.isFunctionDeclaration(st) ? { kind: 'function', fn: st } : { kind: 'other' };
			}
			if (ts.isImportDeclaration(st)) {
				const c = st.importClause;
				const names = [];
				if (c?.name) names.push(c.name.text);
				if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) names.push(c.namedBindings.name.text);
				if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) for (const el of c.namedBindings.elements) names.push(el.name.text);
				if (names.includes(name)) return { kind: 'other' };
			}
		}
	}
	return undefined;
}

/** The expressions a function returns (its arrow body, or each `return`). */
function returnedExpressions(fn) {
	if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return [fn.body];
	if (!fn.body) return [];
	const out = [];
	const visit = (node) => {
		if (node !== fn.body && ts.isFunctionLike(node)) return;
		if (ts.isReturnStatement(node)) out.push(node.expression);
		ts.forEachChild(node, visit);
	};
	visit(fn.body);
	return out;
}

/** The function a call invokes, when it's declared in the same file. */
function localFunction(call) {
	const callee = unwrap(call.expression);
	if (!ts.isIdentifier(callee)) return undefined;
	const d = resolve(callee, callee.text);
	if (d?.kind === 'function') return d.fn;
	if (d?.kind === 'const') {
		const init = unwrap(d.init);
		if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
	}
	return undefined;
}

function unwrap(node) {
	let n = node;
	while (
		ts.isParenthesizedExpression(n) ||
		ts.isAsExpression(n) ||
		ts.isNonNullExpression(n) ||
		ts.isSatisfiesExpression?.(n) ||
		ts.isTypeAssertionExpression?.(n)
	) {
		n = n.expression;
	}
	return n;
}

function calleeName(call) {
	const e = unwrap(call.expression);
	if (ts.isIdentifier(e)) return e.text;
	if (ts.isPropertyAccessExpression(e)) return e.name.text;
	return undefined;
}

const BB_UTILS = /^@aws-blocks\/core\/bb-utils$/;

/** The module a namespace import binds `id` to (`import * as u from '…'`), if any. */
function namespaceImportSource(id) {
	for (const st of id.getSourceFile().statements) {
		const b = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
		if (b && ts.isNamespaceImport(b) && b.name.text === id.text && ts.isStringLiteral(st.moduleSpecifier)) return st.moduleSpecifier.text;
	}
	return undefined;
}

/**
 * The name an escape-helper call is trusted under. The guards trust
 * `escapeRegExp`/`escapeRegex`/`escapeHtml`/`escapeAttr`/`esc` by name, which is
 * only sound because `findWeakEscapeHelpers` checks every declaration of those
 * names in the tree. So only a bare call (`esc(x)`) or a call on a namespace
 * import of `@aws-blocks/core/bb-utils` (`u.escapeHtml(x)`) counts: a method
 * (`util.esc(x)`) can resolve to code the integrity check never sees.
 */
function trustedCallName(call) {
	const e = unwrap(call.expression);
	if (ts.isIdentifier(e)) return e.text;
	if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && BB_UTILS.test(namespaceImportSource(e.expression) ?? '')) {
		return e.name.text;
	}
	return undefined;
}

// The hand-written regex escape: `s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`.
// The character class must hold every metacharacter (`-` is optional).
const REGEX_META = ['\\\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|'];
function isInlineRegexEscape(call) {
	if (calleeName(call) !== 'replace' || call.arguments.length !== 2) return false;
	const [re, rep] = call.arguments.map(unwrap);
	if (!ts.isRegularExpressionLiteral(re) || !(ts.isStringLiteral(rep) && rep.text === '\\$&')) return false;
	const m = /^\/\[(.*)\]\/g[a-z]*$/.exec(re.text);
	return !!m && REGEX_META.every((c) => m[1].includes(c === '\\\\' ? '\\\\' : `\\${c}`) || m[1].includes(c));
}

/**
 * Whether `node` is a compile-time constant: a literal, a template or `+` of
 * constants, a `const` bound to a constant, or a value that passes through one
 * of `ctx.safeCalls` (an escape helper).
 */
function isConstant(node, ctx, depth = 0) {
	if (depth > 12) return false;
	const n = unwrap(node);
	if (
		ts.isStringLiteral(n) ||
		ts.isNoSubstitutionTemplateLiteral(n) ||
		ts.isNumericLiteral(n) ||
		ts.isRegularExpressionLiteral(n) ||
		n.kind === ts.SyntaxKind.TrueKeyword ||
		n.kind === ts.SyntaxKind.FalseKeyword
	) {
		return true;
	}
	if (ts.isTemplateExpression(n)) return n.templateSpans.every((s) => isConstant(s.expression, ctx, depth + 1));
	// String.raw`…${CONST}…`
	if (ts.isTaggedTemplateExpression(n) && n.tag.getText() === 'String.raw') return isConstant(n.template, ctx, depth + 1);
	if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		return isConstant(n.left, ctx, depth + 1) && isConstant(n.right, ctx, depth + 1);
	}
	if (ts.isConditionalExpression(n)) {
		return isConstant(n.whenTrue, ctx, depth + 1) && isConstant(n.whenFalse, ctx, depth + 1);
	}
	if (ts.isIdentifier(n)) {
		const d = resolve(n, n.text);
		const key = d?.init ?? d?.of;
		if (!key || ctx.seen.has(key)) return false;
		ctx.seen.add(key);
		try {
			if (d.kind === 'const') return isConstant(d.init, ctx, depth + 1);
			// for (const x of [constants]) → x is a constant.
			const of = unwrap(d.of);
			if (ts.isArrayLiteralExpression(of)) return of.elements.every((e) => isConstant(e, ctx, depth + 1));
			return false;
		} finally {
			ctx.seen.delete(key);
		}
	}
	// `CONST_RE.source` of a regex literal, and `[...consts].join(sep)`.
	if (ts.isPropertyAccessExpression(n) && n.name.text === 'source') return isConstant(n.expression, ctx, depth + 1);
	if (ts.isArrayLiteralExpression(n)) return n.elements.every((e) => isConstant(e, ctx, depth + 1));
	if (ts.isCallExpression(n)) {
		const name = calleeName(n);
		const trusted = trustedCallName(n);
		if (trusted && ctx.safeCalls.test(trusted)) return true;
		if (ctx.inlineEscape?.(n)) return true;
		const receiver = ts.isPropertyAccessExpression(unwrap(n.expression)) ? unwrap(n.expression).expression : undefined;
		if (name === 'join' && receiver) {
			return isConstant(receiver, ctx, depth + 1) && n.arguments.every((a) => isConstant(a, ctx, depth + 1));
		}
		// `safe.replace(/re/g, 'constant')` stays safe: the replacement is authored text.
		if (name === 'replace' && receiver && n.arguments.length === 2 && ts.isRegularExpressionLiteral(unwrap(n.arguments[0]))) {
			return isConstant(receiver, ctx, depth + 1) && isConstant(n.arguments[1], ctx, depth + 1);
		}
	}
	return false;
}

// ─── Regex ───────────────────────────────────────────────────────────────────

/** Calls whose result is a regex-safe fragment. */
export const REGEX_SAFE_CALLS = /^(?:escapeRegExp|escapeRegex)$/;

/**
 * `new RegExp(x)` / `RegExp(x)` where the pattern `x` isn't a constant built
 * only from literals, `const`s and `escapeRegExp(...)`.
 */
export function findRegexSinks(file, text) {
	const sf = parseSource(file, text);
	const ctx = { seen: new Set(), safeCalls: REGEX_SAFE_CALLS, inlineEscape: isInlineRegexEscape };
	const found = [];
	walk(sf, (node) => {
		if (!(ts.isNewExpression(node) || ts.isCallExpression(node))) return;
		const callee = unwrap(node.expression);
		if (!ts.isIdentifier(callee) || callee.text !== 'RegExp') return;
		const arg = node.arguments?.[0];
		if (!arg || isConstant(arg, ctx)) return;
		found.push({ file, line: lineOf(sf, node), kind: 'regex', text: snippet(sf, node) });
	});
	return found;
}

// ─── Shell ───────────────────────────────────────────────────────────────────

const CHILD_PROCESS = /^(?:node:)?child_process$/;
const COMMAND_STRING_FNS = new Set(['exec', 'execSync']);

/** Local names bound to `child_process` exports, and its namespace aliases. */
function childProcessBindings(sf) {
	const named = new Map(); // local name → exported name
	const namespaces = new Set();
	walk(sf, (node) => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && CHILD_PROCESS.test(node.moduleSpecifier.text)) {
			const clause = node.importClause;
			if (clause?.name) namespaces.add(clause.name.text);
			const b = clause?.namedBindings;
			if (b && ts.isNamespaceImport(b)) namespaces.add(b.name.text);
			if (b && ts.isNamedImports(b)) for (const el of b.elements) named.set(el.name.text, (el.propertyName ?? el.name).text);
		}
		// const { execSync } = require('child_process') / const cp = require('node:child_process')
		if (
			ts.isVariableDeclaration(node) &&
			node.initializer &&
			ts.isCallExpression(node.initializer) &&
			ts.isIdentifier(node.initializer.expression) &&
			node.initializer.expression.text === 'require' &&
			node.initializer.arguments[0] &&
			ts.isStringLiteral(node.initializer.arguments[0]) &&
			CHILD_PROCESS.test(node.initializer.arguments[0].text)
		) {
			if (ts.isIdentifier(node.name)) namespaces.add(node.name.text);
			if (ts.isObjectBindingPattern(node.name)) {
				for (const el of node.name.elements) {
					if (ts.isIdentifier(el.name)) named.set(el.name.text, el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text);
				}
			}
		}
	});
	return { named, namespaces };
}

// Programs that parse their own argument as a command line, and the flag that
// makes them do it (`sh -c '…'`, `cmd /c …`, `powershell -Command …`).
const SHELL_PROGRAMS = /^(?:.*[\\/])?(?:sh|bash|zsh|dash|ksh|fish|cmd|cmd\.exe|powershell|powershell\.exe|pwsh|pwsh\.exe)$/i;
const SHELL_COMMAND_FLAG = /^(?:-c|\/c|\/k|-command|-encodedcommand|-e|-ec)$/i;
const ARGV_FNS = new Set(['execFile', 'execFileSync', 'spawn', 'spawnSync']);

/**
 * The object literal an options argument is, resolving a `const` bound to one.
 * Returns `undefined` for a value the scan can't see into.
 */
function optionsLiteral(arg, depth = 0) {
	const a = unwrap(arg);
	if (ts.isObjectLiteralExpression(a)) return a;
	if (depth < 4 && ts.isIdentifier(a)) {
		const d = resolve(a, a.text);
		if (d?.kind === 'const') return optionsLiteral(d.init, depth + 1);
	}
	return undefined;
}

/** `shell` sites in an options object: a `shell` property that isn't `false`, or a spread the scan can't see into. */
function shellOptionSites(obj, depth = 0) {
	const out = [];
	for (const prop of obj.properties) {
		if (ts.isSpreadAssignment(prop)) {
			const inner = optionsLiteral(prop.expression);
			if (inner && depth < 4) out.push(...shellOptionSites(inner, depth + 1));
			else out.push({ node: prop, kind: 'shell-option-spread' });
			continue;
		}
		const isShell =
			(ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
			prop.name &&
			(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
			prop.name.text === 'shell';
		if (!isShell) continue;
		const value = ts.isPropertyAssignment(prop) ? unwrap(prop.initializer) : undefined;
		if (value && value.kind === ts.SyntaxKind.FalseKeyword) continue;
		out.push({ node: prop, kind: 'shell-option' });
	}
	return out;
}

/**
 * Three shapes run a string through a shell:
 * - `exec(cmd)` / `execSync(cmd)` from `child_process`, where `cmd` isn't a
 *   constant string;
 * - `execFile`/`execFileSync`/`spawn`/`spawnSync` from `child_process` that
 *   start a shell program (`sh`, `bash`, `zsh`, `cmd`, `powershell`, `pwsh`, …)
 *   with its command flag (`-c`, `/c`, `-Command`), where an argument after the
 *   flag isn't a constant, or where argv isn't an array literal the scan can see;
 * - any call passed an options object with a `shell` property that isn't the
 *   literal `false` (`spawn(cmd, { shell: true })`, `execFileSync(f, args, { shell: isWin })`),
 *   because then the arguments are joined into one shell command line. An
 *   options `const` is resolved to its object literal, and a spread the scan
 *   can't see into (`{ ...opts }`) is reported too, since it may carry `shell`.
 */
export function findShellSinks(file, text) {
	const sf = parseSource(file, text);
	const { named, namespaces } = childProcessBindings(sf);
	const ctx = { seen: new Set(), safeCalls: /^$/ };
	const found = [];
	walk(sf, (node) => {
		if (!ts.isCallExpression(node)) return;
		const callee = unwrap(node.expression);
		let exported;
		if (ts.isIdentifier(callee)) exported = named.get(callee.text);
		else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text)) {
			exported = callee.name.text;
		}
		if (exported && COMMAND_STRING_FNS.has(exported)) {
			const cmd = node.arguments[0];
			if (cmd && !isConstant(cmd, ctx)) {
				found.push({ file, line: lineOf(sf, node), kind: 'shell-command-string', text: snippet(sf, node) });
				return;
			}
		}
		if (exported && ARGV_FNS.has(exported)) {
			const program = node.arguments[0] && unwrap(node.arguments[0]);
			const programText = program && (ts.isStringLiteral(program) || ts.isNoSubstitutionTemplateLiteral(program)) ? program.text : undefined;
			if (programText && SHELL_PROGRAMS.test(programText)) {
				const argv = node.arguments[1] && unwrap(node.arguments[1]);
				let raw = !argv || !ts.isArrayLiteralExpression(argv);
				if (!raw) {
					const flag = argv.elements.findIndex((e) => {
						const u = unwrap(e);
						return (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) && SHELL_COMMAND_FLAG.test(u.text);
					});
					raw = flag >= 0 && argv.elements.slice(flag + 1).some((e) => ts.isSpreadElement(e) || !isConstant(e, ctx));
				}
				if (raw) {
					found.push({ file, line: lineOf(sf, node), kind: 'shell-program-argv', text: snippet(sf, node) });
					return;
				}
			}
		}
		for (const arg of node.arguments) {
			const a = unwrap(arg);
			// Only literal options objects, plus a `const` options identifier passed to child_process.
			const obj = ts.isObjectLiteralExpression(a) ? a : exported ? optionsLiteral(a) : undefined;
			if (!obj) continue;
			for (const site of shellOptionSites(obj)) {
				if (site.kind === 'shell-option-spread' && !exported) continue;
				found.push({ file, line: lineOf(sf, site.node), kind: site.kind, text: snippet(sf, site.node) });
			}
		}
	});
	return found;
}

// ─── HTML ────────────────────────────────────────────────────────────────────

/** Calls whose result is safe to place in HTML text or a quoted attribute. */
export const HTML_SAFE_CALLS = /^(?:escapeHtml|escapeHTML|escapeAttr|esc|encodeURIComponent)$/;

// Template text that contains HTML markup: a closing tag of an HTML element, an
// opening tag with attributes, a bare opening tag of an element that isn't also
// a common placeholder word (`<path>`, `<name>` and `<command>` in CLI usage
// text aren't HTML), a comment, or a doctype.
const HTML_ELEMENTS =
	'a|abbr|article|aside|b|body|blockquote|br|button|caption|code|dd|details|div|dl|dt|em|fieldset|footer|form|h[1-6]|head|header|hr|html|i|iframe|img|input|label|legend|li|link|main|meta|nav|noscript|ol|option|p|path|pre|script|section|select|small|span|strong|style|summary|svg|table|tbody|td|textarea|tfoot|th|thead|title|tr|u|ul';
const BARE_ELEMENTS = 'b|body|br|code|div|em|h[1-6]|hr|html|i|li|ol|p|pre|script|span|strong|style|svg|tbody|td|th|thead|tr|u|ul';
const HTML_TAG = new RegExp(
	`</(?:${HTML_ELEMENTS})>|<(?:${HTML_ELEMENTS})\\s+[\\w:-]+(?:=|\\s|/?>|$)|<(?:${BARE_ELEMENTS})\\s*/?>|<!--|<!DOCTYPE`,
	'i',
);

/**
 * Whether `expr` inside an HTML template is safe: a constant, an escape-helper
 * call, a number, or `items.map(x => `<li>…</li>`).join(…)` (the inner template
 * is checked on its own).
 */
function isHtmlSafe(expr, ctx, depth = 0) {
	const n = unwrap(expr);
	if (isConstant(n, ctx)) return true;
	if (depth > 6) return false;
	// A `const` bound to safe markup: `const row = cond ? `<td>…</td>` : '';`
	if (ts.isIdentifier(n)) {
		const d = resolve(n, n.text);
		if (d?.kind === 'const' && !ctx.seen.has(d.init)) {
			ctx.seen.add(d.init);
			try {
				return isHtmlSafe(d.init, ctx, depth + 1);
			} finally {
				ctx.seen.delete(d.init);
			}
		}
		return false;
	}
	// Counts are numbers: `items.length`, `blob.size`.
	if (ts.isPropertyAccessExpression(n) && /^(?:length|size|byteLength)$/.test(n.name.text)) return true;
	if (ts.isCallExpression(n)) {
		const name = calleeName(n);
		const trusted = trustedCallName(n);
		if (trusted && HTML_SAFE_CALLS.test(trusted)) return true;
		// A same-file helper that returns markup or escaped text (its own templates are checked where they are).
		const fn = localFunction(n);
		if (fn && !ctx.seen.has(fn)) {
			ctx.seen.add(fn);
			try {
				const returns = returnedExpressions(fn);
				if (returns.length && returns.every((r) => r && isHtmlSafe(r, ctx, depth + 1))) return true;
			} finally {
				ctx.seen.delete(fn);
			}
		}
		if (name === 'join' && ts.isPropertyAccessExpression(unwrap(n.expression))) return isHtmlSafe(unwrap(n.expression).expression, ctx, depth + 1);
		if (name === 'map' && n.arguments[0]) {
			const fn = unwrap(n.arguments[0]);
			if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && !ts.isBlock(fn.body)) return isHtmlSafe(fn.body, ctx, depth + 1);
		}
		// Number formatting: x.toFixed(n), x.toLocaleString(), String(n) of a number literal.
		if (name === 'toFixed' || name === 'toPrecision') return true;
	}
	// A nested template is itself checked as an HTML template when it has markup;
	// one without markup is safe only if every part is.
	if (ts.isTemplateExpression(n)) {
		const markup = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].some((t) => HTML_TAG.test(t));
		return markup || n.templateSpans.every((s) => isHtmlSafe(s.expression, ctx, depth + 1));
	}
	if (ts.isConditionalExpression(n)) return isHtmlSafe(n.whenTrue, ctx, depth + 1) && isHtmlSafe(n.whenFalse, ctx, depth + 1);
	if (ts.isBinaryExpression(n)) {
		const op = n.operatorToken.kind;
		if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
			return isHtmlSafe(n.left, ctx, depth + 1) && isHtmlSafe(n.right, ctx, depth + 1);
		}
		// Arithmetic and comparisons produce numbers and booleans. An assignment
		// (`=`, `+=`, `||=`, `??=`, …) yields its right-hand value, and a comma its
		// last operand, so neither is a number.
		const assignment = op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment;
		return !assignment && op !== ts.SyntaxKind.CommaToken;
	}
	if (ts.isPrefixUnaryExpression(n)) return true;
	return false;
}

// The literal text before an interpolation ends inside the value of an
// attribute that HTML escaping doesn't make safe: an event handler (script), a
// URL (`javascript:`), `srcdoc` (a whole document) or `style` (more CSS
// declarations). `escapeHtml` keeps a value inside the quotes, not out of the
// script, URL or CSS parsed from them.
const RISKY_ATTRIBUTE = /[\s"'/](on[a-z]+|href|src|srcdoc|formaction|action|xlink:href|style)\s*=\s*(?:"[^"]*|'[^']*|[^\s"'>`=]*)$/i;
const URL_ATTRIBUTE = /^(?:href|src|formaction|action|xlink:href)$/i;

/** The risky attribute the interpolation after `prefix` lands in, if any. */
function riskyAttribute(prefix) {
	return RISKY_ATTRIBUTE.exec(prefix)?.[1];
}

/**
 * Whether `expr` is a JavaScript string literal made safe for an event-handler
 * attribute: an HTML escape of `JSON.stringify(…)` (`escapeHtml(JSON.stringify(id))`),
 * or a same-file helper that only returns one (`jsArg(id)`). JSON makes it a JS
 * literal; the escape keeps it inside the attribute quotes.
 */
function isJsLiteralArg(expr, seen = new Set()) {
	const n = unwrap(expr);
	if (!ts.isCallExpression(n)) return false;
	const trusted = trustedCallName(n);
	if (trusted && HTML_SAFE_CALLS.test(trusted) && trusted !== 'encodeURIComponent' && n.arguments.length === 1) {
		const inner = unwrap(n.arguments[0]);
		const callee = ts.isCallExpression(inner) ? unwrap(inner.expression) : undefined;
		return !!callee && ts.isPropertyAccessExpression(callee) && callee.getText() === 'JSON.stringify';
	}
	const fn = localFunction(n);
	if (!fn || seen.has(fn)) return false;
	seen.add(fn);
	const returns = returnedExpressions(fn);
	return returns.length > 0 && returns.every((r) => r && isJsLiteralArg(r, seen));
}

/**
 * A template literal whose text contains an HTML tag and that interpolates a
 * value which isn't a constant or an `escapeHtml(...)`-style call. Inside an
 * `on*=`, URL (`href=`, `src=`, `formaction=`, `action=`), `srcdoc=` or
 * `style=` value an escape helper isn't enough: only a constant passes (or,
 * in a URL attribute, `encodeURIComponent(...)`, which encodes the `:` of a
 * scheme), and anything else needs an allowlist entry.
 */
export function findHtmlSinks(file, text) {
	const sf = parseSource(file, text);
	const ctx = { seen: new Set(), safeCalls: HTML_SAFE_CALLS };
	const found = [];
	walk(sf, (node) => {
		if (!ts.isTemplateExpression(node)) return;
		// A tagged template (html`…`, css`…`, sql`…`) escapes through its tag.
		if (ts.isTaggedTemplateExpression(node.parent)) return;
		const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
		if (!parts.some((t) => HTML_TAG.test(t))) return;
		node.templateSpans.forEach((span, i) => {
			// The text before this span, with earlier interpolations as a placeholder.
			const attr = riskyAttribute(parts.slice(0, i + 1).join('x'));
			if (attr) {
				const safeCalls = URL_ATTRIBUTE.test(attr) ? /^encodeURIComponent$/ : /^$/;
				if (isConstant(span.expression, { seen: new Set(), safeCalls })) return;
				// An unquoted JS literal argument: `onclick="go(${jsArg(id)})"`.
				const before = parts[i];
				if (/^on/i.test(attr) && !/['"`]\s*$/.test(before) && isJsLiteralArg(span.expression)) return;
				found.push({ file, line: lineOf(sf, span.expression), kind: 'html-attribute', text: `${attr}=: ${snippet(sf, span.expression)}` });
				return;
			}
			if (isHtmlSafe(span.expression, ctx)) return;
			found.push({ file, line: lineOf(sf, span.expression), kind: 'html', text: snippet(sf, span.expression) });
		});
	});
	return found;
}

// ─── GitHub Actions ──────────────────────────────────────────────────────────

// Expression contexts a contributor can't influence (or that are a fixed set of
// values). Anything else inside `${{ }}` in a `run:` script must go through
// `env:` and be quoted as a shell variable.
const SAFE_CONTEXTS = [
	/^github\.(?:run_id|run_number|run_attempt|sha|repository|repository_id|repository_owner|workspace|event_name|server_url|api_url|job|action_path|retention_days)$/,
	/^github\.event\.(?:pull_request\.number|number|issue\.number)$/,
	/^runner\.\w+$/,
	/^secrets\.[\w-]+$/,
	/^needs\.[\w-]+\.result$/,
	/^steps\.[\w-]+\.(?:outcome|conclusion)$/,
	/^job\.status$/,
	/^(?:success|failure|always|cancelled)\(\)$/,
];

function stripIndexes(expr) {
	return expr.replace(/\[\s*'([^']*)'\s*\]/g, '.$1').replace(/\s+/g, ' ').trim();
}

/** Every context reference inside one `${{ … }}` expression. */
function contextRefs(expr) {
	const refs = [];
	const cleaned = stripIndexes(expr).replace(/'[^']*'/g, "''");
	for (const m of cleaned.matchAll(/\b(github|inputs|env|steps|needs|matrix|vars|secrets|runner|job|strategy)\b(?:\.[\w-]+|\.\*)*/g)) {
		refs.push(m[0]);
	}
	return refs;
}

function isStaticMatrix(job) {
	const matrix = job?.strategy?.matrix;
	if (matrix === undefined) return false;
	if (typeof matrix === 'string') return false;
	return !JSON.stringify(matrix).includes('${{');
}

/** Lines of a heredoc operator whose delimiter is unquoted (so the body expands). */
function unquotedHeredocs(script) {
	const out = [];
	const lines = script.split('\n');
	for (let i = 0; i < lines.length; i++) {
		// Drop quoted strings first so `echo 'x<<EOF'` isn't read as a heredoc.
		const code = lines[i].replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
		for (const m of code.matchAll(/(?:^|[\s;|&(])<<-?[ \t]*([A-Za-z_][\w-]*)/g)) out.push({ offset: i, delim: m[1] });
	}
	return out;
}

// The line that opens a `run:` / `script:` value.
const KEY_LINE = { run: /^\s*(?:-\s+)?run:/, script: /^\s*(?:-\s+)?script:/ };

/**
 * In each workflow and composite action: a `${{ }}` expression inside a `run:`
 * script (or an `actions/github-script` `script:`) whose context a contributor
 * can influence, and any heredoc in a `run:` script with an unquoted delimiter.
 *
 * Reported lines are the line of the `run:`/`script:` key plus the offset of
 * the expression inside the block, which is exact for `|` block scalars.
 */
export function findWorkflowSinks(file, text) {
	const doc = parseYaml(text, { keepSourceTokens: false });
	const lines = text.split('\n');
	const found = [];
	const steps = [];
	for (const job of Object.values(doc?.jobs ?? {})) for (const step of job?.steps ?? []) steps.push({ job, step });
	for (const step of doc?.runs?.steps ?? []) steps.push({ job: undefined, step });

	// Locate each script in the file so reported sites carry a real line number.
	let cursor = 0;
	const locate = (key, body) => {
		const first = body.split('\n').find((l) => l.trim() !== '') ?? '';
		for (let i = cursor; i < lines.length; i++) {
			if (KEY_LINE[key].test(lines[i])) {
				const inline = lines[i].includes(first.trim());
				const start = inline ? i : i + 1;
				for (let j = start; j < Math.min(lines.length, start + 3); j++) {
					if (lines[j].includes(first.trim())) {
						cursor = i + 1;
						return { keyLine: i + 1, bodyLine: j + 1 };
					}
				}
			}
		}
		return { keyLine: 0, bodyLine: 0 };
	};

	for (const { job, step } of steps) {
		const scripts = [];
		if (typeof step?.run === 'string') scripts.push({ key: 'run', body: step.run, viaShell: true });
		if (typeof step?.uses === 'string' && step.uses.startsWith('actions/github-script@') && typeof step.with?.script === 'string') {
			scripts.push({ key: 'script', body: step.with.script, viaShell: false });
		}
		for (const { key, body, viaShell } of scripts) {
			const { bodyLine } = locate(key, body);
			const bodyLines = body.split('\n');
			bodyLines.forEach((l, i) => {
				for (const m of l.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
					const unsafe = contextRefs(m[1]).filter(
						(ref) => !SAFE_CONTEXTS.some((re) => re.test(ref)) && !(ref.startsWith('matrix.') && isStaticMatrix(job)),
					);
					if (unsafe.length) {
						found.push({ file, line: bodyLine + i, kind: 'workflow-expression', text: `${m[0]} (${unsafe.join(', ')})` });
					}
				}
			});
			if (viaShell) {
				for (const h of unquotedHeredocs(body)) {
					found.push({ file, line: bodyLine + h.offset, kind: 'workflow-heredoc', text: `<<${h.delim}` });
				}
			}
		}
	}
	return found;
}

/** Workflow and composite-action files under .github/. */
export function listWorkflowFiles() {
	const out = execFileSync('git', ['ls-files', '-z', '.github/workflows', '.github/actions'], { cwd: ROOT, encoding: 'utf8' });
	return out.split('\0').filter((f) => /\.ya?ml$/.test(f) && (f.startsWith('.github/workflows/') || /\/action\.ya?ml$/.test(f)));
}

// ─── Codegen ─────────────────────────────────────────────────────────────────

/**
 * Generator sources: the code that turns an OpenRPC spec into Kotlin, Swift
 * and Dart source. Spec values (names, enum values, URLs, descriptions) reach
 * the generated code only through each language's emitters:
 * - Kotlin: `kotlinStringLiteral` / `kotlinMessageLiteral` (or KotlinPoet `%S`), `neutraliseKdoc` for KDoc;
 * - Swift: `swiftStringLiteral`, or `swiftStringContent` inside a literal the line opens (`"\"\(swiftStringContent(x))\""`);
 * - Dart: `_dartStringLiteral`.
 */
export function listCodegenFiles() {
	const out = execFileSync(
		'git',
		['ls-files', '-z', 'native/kotlin/codegen/src/main', 'native/swift/Sources/BlocksCodegen', 'native/dart/packages/blocks_codegen/lib'],
		{ cwd: ROOT, encoding: 'utf8' },
	);
	return out.split('\0').filter((f) => /\.(?:kt|swift|dart)$/.test(f));
}

// A generated string literal opened right before an interpolation:
// Kotlin  "…\"${x}…"  or  "…\"$x…"
// Swift   "…\"\(x)…"
// Dart    "…'${x}…" / "…'$x…"  or  '…\'${x}…'  or  "…\"${x}…"
const CODEGEN_PATTERNS = {
	kt: /\\"\$(?:\{([^}]*)\}|([A-Za-z_][\w.]*))/g,
	swift: /\\"\\\(([^)]*)\)/g,
	dart: /(?:"[^"\n]*'|\\'|\\")\$(?:\{([^}]*)\}|([A-Za-z_]\w*))/g,
};

// Interpolations that already went through an emitter (or are diagnostics text).
const CODEGEN_SAFE = /^(?:kotlinStringLiteral|kotlinMessageLiteral|swiftStringLiteral|swiftStringContent|_dartStringLiteral|escapeForDiagnostic|escapedForDiagnostic)\(|\.forDiagnostic\(\)$/;

// A line that hands text to the generated source (as opposed to building an
// error message for the person running the generator).
const EMITS = /\b(?:writeln|write|add|addAll|append|addStatement|addCode|addKdoc|beginControlFlow|nextControlFlow|of)\(|^\s*\+\s*"|^\s*return\s+"|\+=\s*"/;
const DIAGNOSTIC = /\bthrow\b|Exception\(|Error\(\s*$|\berror\(|fatalError\(|\bwarn(?:ing)?\(|\bwarnings\.add\(/;

/** Spec-facing generator files: the parsers only read the spec, so they're out of scope. */
const CODEGEN_EXCLUDE = /(?:parser\.dart|Parser\.kt|Parser\.swift)$/;

/** Lines that emit a quoted literal into generated code with a raw interpolation inside it. */
export function findCodegenSinks(file, text) {
	const ext = file.split('.').pop();
	const pattern = CODEGEN_PATTERNS[ext];
	if (!pattern || CODEGEN_EXCLUDE.test(file)) return [];
	const lines = text.split('\n');
	const found = [];
	lines.forEach((line, i) => {
		const code = line.trim();
		if (code.startsWith('//') || code.startsWith('*') || code.startsWith('///')) return;
		const raw = [...line.matchAll(pattern)].map((m) => (m[1] ?? m[2] ?? '').trim()).filter((e) => !CODEGEN_SAFE.test(e));
		if (!raw.length) return;
		// Look back over the statement this line continues (up to 4 lines).
		const context = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
		const ownLineEmits = EMITS.test(line);
		if (!ownLineEmits && DIAGNOSTIC.test(context)) return;
		if (!ownLineEmits && !EMITS.test(context)) return;
		if (DIAGNOSTIC.test(line)) return;
		found.push({ file, line: i + 1, kind: 'codegen-literal', text: `${code.slice(0, 100)}  (raw: ${raw.join(', ')})` });
	});
	return found;
}

// ─── Escape helpers ──────────────────────────────────────────────────────────

const HTML_REFERENCES = [/&amp;/, /&lt;/, /&gt;/, /&quot;|&#34;|&#x22;/i, /&#39;|&#x27;|&apos;/i];

function declaredName(name) {
	return name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) ? name.text.replace(/^#/, '') : undefined;
}

/**
 * Functions declared with `name` in a file: `function name(…)`,
 * `const name = (…) =>`, an object or class method `name(…) {}`, and a property
 * or class field holding a function (`{ name: (…) => … }`, `name = (…) => …`).
 */
function functionsNamed(sf, test) {
	const out = [];
	walk(sf, (node) => {
		if (ts.isFunctionDeclaration(node) && node.name && test(node.name.text)) out.push({ name: node.name.text, fn: node });
		if (ts.isMethodDeclaration(node)) {
			const name = declaredName(node.name);
			if (name && test(name)) out.push({ name, fn: node });
		}
		if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) && node.initializer) {
			const name = declaredName(node.name);
			const init = unwrap(node.initializer);
			if (name && test(name) && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) out.push({ name, fn: init });
		}
	});
	return out;
}

/**
 * The guards trust a call by its name (`escapeRegExp(x)`, `escapeHtml(x)`), so
 * every function declared under one of those names must really escape. Returns
 * the declarations that don't: a regex escape whose character class misses a
 * metacharacter, or an HTML escape that misses one of `& < > " '`. A helper
 * that only delegates to another trusted helper passes.
 */
export function findWeakEscapeHelpers(file, text) {
	const sf = parseSource(file, text);
	const found = [];
	for (const { name, fn } of functionsNamed(sf, (n) => REGEX_SAFE_CALLS.test(n) || HTML_SAFE_CALLS.test(n))) {
		if (name === 'encodeURIComponent') continue;
		// The body, plus the initializers of the constants it reads (an escape table).
		let body = fn.body ? fn.body.getText(sf) : '';
		walk(fn.body ?? fn, (node) => {
			if (!ts.isIdentifier(node)) return;
			const d = resolve(node, node.text);
			if (d?.kind === 'const') body += `\n${d.init.getText(sf)}`;
		});
		let delegates = false;
		let inlineRegex = false;
		walk(fn.body ?? fn, (node) => {
			if (!ts.isCallExpression(node)) return;
			const callee = trustedCallName(node);
			if (callee && callee !== name && (REGEX_SAFE_CALLS.test(callee) || HTML_SAFE_CALLS.test(callee))) delegates = true;
			if (isInlineRegexEscape(node)) inlineRegex = true;
		});
		const ok = REGEX_SAFE_CALLS.test(name) ? inlineRegex || delegates : delegates || HTML_REFERENCES.every((re) => re.test(body));
		if (!ok) found.push({ file, line: lineOf(sf, fn), kind: 'weak-escape-helper', text: `${name}: ${snippet(sf, fn)}` });
	}
	return found;
}

// ─── Allowlist ───────────────────────────────────────────────────────────────

/**
 * Compares detected sites with an allowlist of `{ at: 'file:line', reason }`.
 * Returns the sites not allowlisted and the allowlist entries that match no
 * detected site (stale: the site moved or got fixed, so the entry must go).
 */
export function compareWithAllowlist(sites, allowlist) {
	for (const entry of allowlist) {
		if (!/^[^:]+:\d+$/.test(entry.at)) throw new Error(`allowlist entry must be file:line, got ${JSON.stringify(entry.at)}`);
		if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) {
			throw new Error(`allowlist entry ${entry.at} needs a written reason`);
		}
	}
	const allowed = new Set(allowlist.map((e) => e.at));
	const at = (f) => `${f.file}:${f.line}`;
	const unexpected = sites.filter((f) => !allowed.has(at(f)));
	const hit = new Set(sites.map(at));
	const stale = allowlist.filter((e) => !hit.has(e.at));
	return { unexpected, stale };
}

/** Formats detected sites for an assertion message. */
export function report(title, { unexpected, stale }) {
	const lines = [];
	if (unexpected.length) {
		lines.push(`${title}: ${unexpected.length} unguarded site(s):`);
		for (const f of unexpected) lines.push(`  ${f.file}:${f.line}  [${f.kind}]  ${f.text}`);
	}
	if (stale.length) {
		lines.push(`${title}: ${stale.length} allowlist entr${stale.length === 1 ? 'y matches' : 'ies match'} no site (remove or update):`);
		for (const e of stale) lines.push(`  ${e.at}  (${e.reason})`);
	}
	return lines.join('\n');
}

/** Runs `detector` over `files` (paths relative to the repo root). */
export function scan(files, detector) {
	return files.flatMap((f) => detector(f, readFileSync(join(ROOT, f), 'utf8')));
}
