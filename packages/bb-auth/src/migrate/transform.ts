// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `bb-auth migrate` source transform: rewrites one file from `AuthBasic` /
 * `AuthCognito` / `AuthOIDC` to `Auth`.
 *
 * **How.** The TypeScript compiler API parses the file; the transform computes
 * span edits against the *original* text and splices them in. Nothing the
 * codemod does not touch moves by a byte, so formatting and comments survive.
 * Edits come in two kinds: leaf edits (a renamed identifier, method, error
 * name; an inserted TODO comment) and jobs, which rebuild a larger span (an
 * options object, an import declaration) from the original text *with the leaf
 * edits inside it applied*. Jobs run innermost first.
 *
 * **The one invariant.** The scope and `id` arguments of every old block's
 * constructor are never edited: changing the id changes the block's `fullId`,
 * which replaces the Cognito user pool and deletes every user in it. Edits
 * inside those spans are refused while building, and {@link assertIdsPreserved}
 * re-parses the output and compares every constructor's first two arguments
 * before anything is written.
 *
 * The `typescript` module is passed in, never imported: the CLI loads the
 * consumer's own copy lazily, so `@aws-blocks/bb-auth` carries no TypeScript
 * dependency at runtime.
 */

import { dirname, resolve } from 'node:path';
import type * as TS from 'typescript';
import {
	AUTH_ERROR_NAMES,
	BASIC_STRING_RENAMES,
	COGNITO_METHOD_RENAMES,
	CONFIRM_SIGN_IN_KEYS,
	DEAD_SUBPATHS,
	DISTINCTIVE_OLD_METHODS,
	ERROR_CHECK_FUNCTIONS,
	ERROR_CHECK_TODO,
	ERROR_KEY_RULES,
	IMPORT_TODOS,
	NAME_RULES,
	type NameRule,
	NEW_MODULE,
	OIDC_ENGINE_ERROR,
	OIDC_ENGINE_ERROR_TODO,
	OIDC_GONE_MEMBERS,
	type OidcFactory,
	OLD_MODULES,
	OLD_SUBPATHS,
	type OldBlock,
	SOCIAL_IDPS,
	SUBPATH_NAME_RULES,
	type SUMMARY_WARNINGS,
	TODO_TAG,
	TODOS,
	UMBRELLA_MODULES,
	umbrellaBlockFor,
	unknownOldSubpath,
} from './rules.js';
import { applyEdits, type Edit, indentAt, lineStart, newlineOf, reindent, startsLine } from './text.js';

/** The `typescript` module. */
export type TypeScript = typeof TS;

/** What the whole project uses, from the analysis pass. */
export interface ProjectInfo {
	/** Old blocks imported anywhere in the project. */
	blocks: ReadonlySet<OldBlock>;
	/**
	 * Exported bindings initialized with an old block's constructor, keyed by the
	 * module's absolute path without extension, so `import { auth } from './auth.js'`
	 * resolves.
	 */
	instanceExports: ReadonlyMap<string, ReadonlyMap<string, OldBlock>>;
}

/** The result of transforming one file. */
export interface FileResult {
	output: string;
	changed: boolean;
	/** Human-readable list of what changed. */
	changes: string[];
	/** How many TODO comments were added. */
	todos: number;
	/**
	 * Why this file needs a person before it compiles, beyond its TODOs — e.g.
	 * an import the codemod would otherwise have left with an empty name list.
	 * Non-empty: the summary reports the file as "needs attention", not as
	 * rewritten.
	 */
	attention: string[];
	/** Warnings to repeat in the printed summary (`SUMMARY_WARNINGS` keys), de-duplicated. */
	warnings: SummaryWarning[];
}

/** A key of {@link SUMMARY_WARNINGS}. */
export type SummaryWarning = keyof typeof SUMMARY_WARNINGS;

/** Thrown when an edit would change an old block's scope or id argument. */
export class IdPreservationError extends Error {
	override readonly name = 'IdPreservationError';
}

type Todo = string | readonly string[];

const OLD_CLASS_NAMES = new Set(['AuthBasic', 'AuthCognito', 'AuthOIDC']);
const SHARED_FACTORY_NAMES = new Set(['github', 'stubIdp', 'customOauth2']);

// ─── Analysis pass ────────────────────────────────────────────────────────

/** Strip a module path's extension (and a trailing `/index`) for import resolution. */
export function moduleKey(absPath: string): string {
	return absPath.replace(/\.(d\.)?[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
}

function scriptKind(ts: TypeScript, fileName: string): TS.ScriptKind {
	if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
	if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
	if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
}

function parse(ts: TypeScript, fileName: string, text: string): TS.SourceFile {
	return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(ts, fileName));
}

function moduleText(ts: TypeScript, node: TS.Node | undefined): string | undefined {
	return node && ts.isStringLiteral(node) ? node.text : undefined;
}

/** Which old classes a file imports, by local name. */
function oldClassLocals(ts: TypeScript, sf: TS.SourceFile): Map<string, OldBlock> {
	const out = new Map<string, OldBlock>();
	for (const stmt of sf.statements) {
		if (!ts.isImportDeclaration(stmt)) continue;
		const spec = moduleText(ts, stmt.moduleSpecifier);
		if (spec === undefined) continue;
		const fromOld = OLD_MODULES[spec];
		const fromUmbrella = UMBRELLA_MODULES.has(spec);
		if (!fromOld && !fromUmbrella) continue;
		const bindings = stmt.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		for (const el of bindings.elements) {
			const imported = (el.propertyName ?? el.name).text;
			const block = fromOld ?? umbrellaBlockFor(imported);
			if (block && NAME_RULES[block][imported]?.role === 'class') out.set(el.name.text, block);
		}
	}
	return out;
}

/** Local names of `import * as x from '@aws-blocks/blocks'` (or `/cdk`). */
function umbrellaNamespaceLocals(ts: TypeScript, sf: TS.SourceFile): Set<string> {
	const out = new Set<string>();
	for (const stmt of sf.statements) {
		if (!ts.isImportDeclaration(stmt)) continue;
		const spec = moduleText(ts, stmt.moduleSpecifier);
		const b = stmt.importClause?.namedBindings;
		if (spec && UMBRELLA_MODULES.has(spec) && b && ts.isNamespaceImport(b)) out.add(b.name.text);
	}
	return out;
}

function unwrap(ts: TypeScript, node: TS.Expression): TS.Expression {
	let n = node;
	while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
	return n;
}

/** Analyse one file for the project-wide pass. */
export function analyzeFile(
	ts: TypeScript,
	fileName: string,
	text: string,
): { blocks: Set<OldBlock>; instanceExports: Map<string, OldBlock> } {
	const sf = parse(ts, fileName, text);
	const classes = oldClassLocals(ts, sf);
	const blocks = new Set<OldBlock>(classes.values());
	const namespaces = umbrellaNamespaceLocals(ts, sf);
	/** `blocks.AuthCognito` on an `import * as blocks` of the umbrella → its block. */
	const namespacedClass = (e: TS.Expression): OldBlock | undefined => {
		if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.expression)) return undefined;
		if (!namespaces.has(e.expression.text)) return undefined;
		const block = umbrellaBlockFor(e.name.text);
		return block && NAME_RULES[block][e.name.text]?.role === 'class' ? block : undefined;
	};
	if (namespaces.size > 0) {
		const visit = (n: TS.Node): void => {
			const pair = ts.isPropertyAccessExpression(n)
				? { left: n.expression, right: n.name }
				: ts.isQualifiedName(n)
					? { left: n.left, right: n.right }
					: undefined;
			if (pair && ts.isIdentifier(pair.left) && namespaces.has(pair.left.text) && ts.isIdentifier(pair.right)) {
				const block = SHARED_FACTORY_NAMES.has(pair.right.text) ? undefined : umbrellaBlockFor(pair.right.text);
				if (block) blocks.add(block);
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	for (const stmt of sf.statements) {
		if (!ts.isImportDeclaration(stmt) && !ts.isExportDeclaration(stmt)) continue;
		const spec = moduleText(ts, stmt.moduleSpecifier);
		const block = spec === undefined ? undefined : OLD_MODULES[spec];
		if (block) blocks.add(block);
	}
	const locals = new Map<string, OldBlock>();
	const exported = new Map<string, OldBlock>();
	for (const stmt of sf.statements) {
		if (!ts.isVariableStatement(stmt)) continue;
		const isExported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
		for (const decl of stmt.declarationList.declarations) {
			if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
			const init = unwrap(ts, decl.initializer);
			if (!ts.isNewExpression(init)) continue;
			const block = ts.isIdentifier(init.expression)
				? classes.get(init.expression.text)
				: namespacedClass(init.expression);
			if (!block) continue;
			locals.set(decl.name.text, block);
			if (isExported) exported.set(decl.name.text, block);
		}
	}
	for (const stmt of sf.statements) {
		if (!ts.isExportDeclaration(stmt) || stmt.moduleSpecifier || !stmt.exportClause) continue;
		if (!ts.isNamedExports(stmt.exportClause)) continue;
		for (const el of stmt.exportClause.elements) {
			const block = locals.get((el.propertyName ?? el.name).text);
			if (block) exported.set(el.name.text, block);
		}
	}
	return { blocks, instanceExports: exported };
}

// ─── Transform pass ───────────────────────────────────────────────────────

interface ImportedSpec {
	node: TS.ImportSpecifier | TS.ExportSpecifier;
	imported: string;
	local: string;
	aliased: boolean;
	typeOnly: boolean;
	block?: OldBlock;
	rule?: NameRule;
}

interface ImportJob {
	decl: TS.ImportDeclaration | TS.ExportDeclaration;
	specs: ImportedSpec[];
	/** New module specifier text (without quotes), or undefined to keep it. */
	newModule?: string;
	/**
	 * Names with no equivalent in the new module: they stay in a declaration
	 * of the *old* module (with a TODO), and only `specs` move to `newModule`.
	 */
	leftover?: ImportedSpec[];
}

/** An import job with its names rendered, before it is queued. */
interface PlannedImport {
	job: ImportJob;
	current: string;
	target: string;
	named: TS.NamedImports | TS.NamedExports | undefined;
	out: string[];
	/** The rendered names kept on the old module. */
	leftover: string[];
	/** Its names moved into an earlier declaration of the same module. */
	merged: boolean;
}

interface Job {
	start: number;
	end: number;
	run: () => string;
}

/** A rendered options-object entry. */
interface OutEntry {
	/** `null`: `raw` is emitted verbatim (a spread, a method, a shorthand). */
	key: string | null;
	value: OutValue;
	comments: string[];
	todos: Todo[];
	trailing?: string;
}

type OutValue =
	| { t: 'text'; text: string; indent: string }
	| { t: 'obj'; entries: OutEntry[]; inline?: boolean }
	| { t: 'call'; callee: string; arg?: OutValue };

interface Layout {
	multiline: boolean;
	unit: string;
	nl: string;
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Transform one file. Pure: no I/O. */
export function transformFile(ts: TypeScript, fileName: string, text: string, project: ProjectInfo): FileResult {
	return new FileMigrator(ts, fileName, text, project).run();
}

class FileMigrator {
	private readonly sf: TS.SourceFile;
	private readonly nl: string;
	private readonly quote: string;
	private readonly leaf: (Edit & { consumed?: boolean })[] = [];
	private readonly jobs: Job[] = [];
	private readonly anchors = new Map<number, { indent: string; todos: Todo[]; consumed?: boolean }>();
	private readonly protectedRanges: [number, number][] = [];
	private readonly changes: string[] = [];
	private readonly warnings = new Set<SummaryWarning>();

	private readonly classLocals = new Map<string, OldBlock>();
	private readonly errorsLocals = new Map<string, OldBlock>();
	private readonly newErrorsLocals = new Set<string>();
	private readonly factoryLocals = new Map<string, OidcFactory>();
	/** Unaliased renamed imports: local name → new local name. */
	private readonly renames = new Map<string, string>();
	private readonly instanceLocals = new Map<string, OldBlock>();
	private readonly thisInstances = new Map<string, OldBlock>();
	private readonly consumedFactoryCalls = new Set<TS.CallExpression>();
	private readonly importJobs: ImportJob[] = [];
	/** Local names of `import * as x from '@aws-blocks/blocks'` (or `/cdk`). */
	private readonly umbrellaNamespaces = new Set<string>();
	private readonly attention: string[] = [];
	private authTouching = false;

	constructor(
		private readonly ts: TypeScript,
		private readonly fileName: string,
		private readonly text: string,
		private readonly project: ProjectInfo,
	) {
		this.sf = parse(ts, fileName, text);
		this.nl = newlineOf(text);
		this.quote = detectQuote(ts, this.sf);
	}

	run(): FileResult {
		this.scanImports();
		this.scanInstances();
		this.visit(this.sf);
		this.queueImportJobs();
		// Innermost first, so an outer job's slice includes the inner job's result.
		const jobs = [...this.jobs].sort((a, b) => a.end - a.start - (b.end - b.start));
		for (const job of jobs) {
			const out = job.run();
			this.leaf.push({ start: job.start, end: job.end, text: out });
			this.consumeWithin(job.start, job.end, true);
		}
		for (const [pos, anchor] of this.anchors) {
			if (anchor.consumed) continue;
			const text = this.renderAnchor(pos, anchor);
			if (text) this.leaf.push({ start: pos, end: pos, text });
		}
		const live = this.leaf.filter((e) => !e.consumed);
		for (const e of live) this.assertNotProtected(e);
		const output = applyEdits(this.text, live);
		if (output !== this.text) assertIdsPreserved(this.ts, this.fileName, this.text, output);
		return {
			output,
			changed: output !== this.text,
			changes: [...new Set(this.changes)],
			todos: countTodos(output) - countTodos(this.text),
			attention: [...new Set(this.attention)],
			warnings: [...this.warnings],
		};
	}

	// ── Imports ────────────────────────────────────────────────────────────

	private scanImports(): void {
		const { ts } = this;
		const takenNames = this.topLevelNames();
		for (const stmt of this.sf.statements) {
			const isImport = ts.isImportDeclaration(stmt);
			if (!isImport && !ts.isExportDeclaration(stmt)) continue;
			const spec = moduleText(ts, stmt.moduleSpecifier);
			if (spec === undefined) continue;
			if (isImport && spec.startsWith('.')) this.scanRelativeImport(stmt, spec);
			if (isImport && (spec === NEW_MODULE || UMBRELLA_MODULES.has(spec) || spec === '@aws-blocks/auth-common')) {
				const b = stmt.importClause?.namedBindings;
				if (b && ts.isNamedImports(b)) {
					for (const el of b.elements) {
						if ((el.propertyName ?? el.name).text === 'AuthErrors') this.newErrorsLocals.add(el.name.text);
					}
				}
			}
			const dead = DEAD_SUBPATHS[spec];
			if (dead) {
				this.authTouching = true;
				this.scanDeadSubpath(stmt, dead, takenNames);
				continue;
			}
			const subpath = OLD_SUBPATHS[spec];
			const oldBlock = OLD_MODULES[spec];
			const umbrella = UMBRELLA_MODULES.has(spec);
			if (!subpath && !oldBlock && !umbrella) {
				if (unknownOldSubpath(spec)) {
					this.authTouching = true;
					this.todo(stmt, IMPORT_TODOS.unknownSubpath);
				}
				continue;
			}
			const clause = isImport ? stmt.importClause : undefined;
			const bindings = isImport ? clause?.namedBindings : stmt.exportClause;
			if (subpath) {
				this.authTouching = true;
				this.scanSubpath(stmt, spec, subpath, takenNames);
				continue;
			}
			if (bindings && (ts.isNamespaceImport(bindings) || ts.isNamespaceExport(bindings))) {
				if (oldBlock) {
					this.authTouching = true;
					this.todo(stmt, TODOS.namespaceImport);
					this.importJobs.push({ decl: stmt, specs: [], newModule: NEW_MODULE });
				} else if (ts.isNamespaceImport(bindings)) {
					// `import * as blocks from '@aws-blocks/blocks'`: its old members are
					// renamed where they are used (`blocks.AuthCognito` → `blocks.Auth`).
					this.umbrellaNamespaces.add(bindings.name.text);
				}
				continue;
			}
			const elements: readonly (TS.ImportSpecifier | TS.ExportSpecifier)[] =
				bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) ? bindings.elements : [];
			const specs: ImportedSpec[] = [];
			let touched = false;
			// `github` / `stubIdp` / `customOauth2` are also Auth's names: from the
			// umbrella they are old-style only next to an AuthOIDC-specific import.
			const oidcStyle = elements.some((el) => {
				const n = (el.propertyName ?? el.name).text;
				return umbrellaBlockFor(n) === 'oidc' && !SHARED_FACTORY_NAMES.has(n);
			});
			for (const el of elements) {
				const imported = (el.propertyName ?? el.name).text;
				const umbrellaBlock =
					SHARED_FACTORY_NAMES.has(imported) && !oidcStyle ? undefined : umbrellaBlockFor(imported);
				const block = oldBlock ?? umbrellaBlock;
				const rule = block ? NAME_RULES[block][imported] : undefined;
				const s: ImportedSpec = {
					node: el,
					imported,
					local: el.name.text,
					aliased: el.propertyName !== undefined,
					typeOnly: el.isTypeOnly,
					...(block ? { block } : {}),
					...(rule ? { rule } : {}),
				};
				specs.push(s);
				if (!rule || !block) continue;
				touched = true;
				if (!isImport) continue;
				if (rule.role === 'class') this.classLocals.set(s.local, block);
				if (rule.role === 'errors') this.errorsLocals.set(s.local, block);
				if (rule.role === 'factory' && rule.factory) this.factoryLocals.set(s.local, rule.factory);
				const to = rule.to;
				if (typeof to === 'string' && to !== imported && !s.aliased) {
					// Keep the old local name (aliased) when the new one is already taken.
					if (takenNames.has(to) && !this.importsNewName(to)) s.local = imported;
					else this.renames.set(s.local, to);
				}
			}
			if (oldBlock || touched) {
				this.authTouching = true;
				this.importJobs.push({ decl: stmt, specs, ...(oldBlock ? { newModule: NEW_MODULE } : {}) });
			}
		}
	}

	/** One import / export specifier, with its rule; registers the rename of an unaliased import. */
	private specFor(
		el: TS.ImportSpecifier | TS.ExportSpecifier,
		rule: NameRule | undefined,
		takenNames: ReadonlySet<string>,
	): ImportedSpec {
		const imported = (el.propertyName ?? el.name).text;
		const s: ImportedSpec = {
			node: el,
			imported,
			local: el.name.text,
			aliased: el.propertyName !== undefined,
			typeOnly: el.isTypeOnly,
			...(rule ? { rule } : {}),
		};
		const to = rule?.to;
		if (this.ts.isImportSpecifier(el) && typeof to === 'string' && to !== imported && !s.aliased) {
			// Keep the old local name (aliased) when the new one is already taken.
			if (!(takenNames.has(to) && !this.importsNewName(to))) this.renames.set(s.local, to);
		}
		return s;
	}

	/** `@aws-blocks/bb-auth-cognito/ui` → `@aws-blocks/bb-auth/ui`, renaming every name it exported. */
	private scanSubpath(
		stmt: TS.ImportDeclaration | TS.ExportDeclaration,
		spec: string,
		target: string,
		takenNames: ReadonlySet<string>,
	): void {
		const rules = SUBPATH_NAME_RULES[spec] ?? {};
		const named = this.namedBindingsOf(stmt);
		const isNamespace = this.ts.isImportDeclaration(stmt)
			? stmt.importClause?.namedBindings !== undefined &&
				this.ts.isNamespaceImport(stmt.importClause.namedBindings)
			: stmt.exportClause !== undefined && this.ts.isNamespaceExport(stmt.exportClause);
		if (isNamespace) this.todo(stmt, TODOS.namespaceImport);
		const specs = named
			? named.elements.map((el) => this.specFor(el, rules[(el.propertyName ?? el.name).text], takenNames))
			: [];
		this.importJobs.push({ decl: stmt, specs, newModule: target });
	}

	/**
	 * `@aws-blocks/bb-auth-oidc/middleware` / `/client`: no replacement module.
	 * Names `@aws-blocks/bb-auth` also exports (the provider helpers, `relayOrigin`,
	 * the error constants and types) move there; the rest (`AuthOIDCClient`,
	 * `handle401`, …) stay on the old path under a TODO.
	 */
	private scanDeadSubpath(
		stmt: TS.ImportDeclaration | TS.ExportDeclaration,
		dead: string,
		takenNames: ReadonlySet<string>,
	): void {
		const named = this.namedBindingsOf(stmt);
		const defaultName = this.ts.isImportDeclaration(stmt) ? stmt.importClause?.name : undefined;
		if (!named || named.elements.length === 0 || defaultName) {
			this.todo(stmt, dead);
			return;
		}
		const mapped: ImportedSpec[] = [];
		const leftover: ImportedSpec[] = [];
		for (const el of named.elements) {
			const rule = NAME_RULES.oidc[(el.propertyName ?? el.name).text];
			const s = this.specFor(el, rule, takenNames);
			if (!rule) {
				leftover.push(s);
				continue;
			}
			mapped.push({ ...s, block: 'oidc' });
			if (!this.ts.isImportSpecifier(el)) continue;
			if (rule.role === 'class') this.classLocals.set(s.local, 'oidc');
			if (rule.role === 'errors') this.errorsLocals.set(s.local, 'oidc');
			if (rule.role === 'factory' && rule.factory) this.factoryLocals.set(s.local, rule.factory);
		}
		if (leftover.length > 0) {
			this.todo(stmt, dead);
			this.todo(stmt, IMPORT_TODOS.noEquivalent(leftover.map((s) => s.imported)));
		}
		if (mapped.length > 0) this.importJobs.push({ decl: stmt, specs: mapped, newModule: NEW_MODULE, leftover });
	}

	private importsNewName(name: string): boolean {
		for (const stmt of this.sf.statements) {
			if (!this.ts.isImportDeclaration(stmt)) continue;
			const spec = moduleText(this.ts, stmt.moduleSpecifier);
			if (spec !== NEW_MODULE && !(spec && UMBRELLA_MODULES.has(spec))) continue;
			const b = stmt.importClause?.namedBindings;
			if (b && this.ts.isNamedImports(b) && b.elements.some((el) => el.name.text === name)) return true;
		}
		return false;
	}

	/** Every name bound at the top level by something other than an old-auth import. */
	private topLevelNames(): Set<string> {
		const { ts } = this;
		const names = new Set<string>();
		for (const stmt of this.sf.statements) {
			if (ts.isImportDeclaration(stmt)) {
				const spec = moduleText(ts, stmt.moduleSpecifier);
				if (spec && (OLD_MODULES[spec] || UMBRELLA_MODULES.has(spec) || spec === NEW_MODULE)) continue;
				const clause = stmt.importClause;
				if (clause?.name) names.add(clause.name.text);
				const b = clause?.namedBindings;
				if (b && ts.isNamespaceImport(b)) names.add(b.name.text);
				if (b && ts.isNamedImports(b)) for (const el of b.elements) names.add(el.name.text);
			} else if (ts.isVariableStatement(stmt)) {
				for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text);
			} else if (
				(ts.isFunctionDeclaration(stmt) ||
					ts.isClassDeclaration(stmt) ||
					ts.isInterfaceDeclaration(stmt) ||
					ts.isTypeAliasDeclaration(stmt) ||
					ts.isEnumDeclaration(stmt)) &&
				stmt.name
			) {
				names.add(stmt.name.text);
			}
		}
		return names;
	}

	private scanRelativeImport(stmt: TS.ImportDeclaration, spec: string): void {
		const b = stmt.importClause?.namedBindings;
		if (!b || !this.ts.isNamedImports(b)) return;
		const exports = this.project.instanceExports.get(moduleKey(resolve(dirname(this.fileName), spec)));
		if (!exports) return;
		for (const el of b.elements) {
			const block = exports.get((el.propertyName ?? el.name).text);
			if (block) {
				this.instanceLocals.set(el.name.text, block);
				this.authTouching = true;
			}
		}
	}

	private queueImportJobs(): void {
		const seenByModule = new Map<string, Set<string>>();
		const planned: PlannedImport[] = [];
		for (const job of this.importJobs) {
			const { decl } = job;
			const current = moduleText(this.ts, decl.moduleSpecifier) ?? '';
			const target = job.newModule ?? current;
			const seen = seenByModule.get(target) ?? new Set<string>();
			seenByModule.set(target, seen);
			const out: string[] = [];
			const goneTodos: string[] = [];
			for (const s of job.specs) {
				const text = this.renderSpec(s, goneTodos);
				if (text === null) continue;
				const key = text.replace(/^type /, '');
				if (seen.has(key)) continue;
				seen.add(key);
				out.push(text);
			}
			for (const t of goneTodos) this.todo(decl, t);
			const leftover = (job.leftover ?? []).map((s) => s.node.getText(this.sf));
			planned.push({ job, current, target, named: this.namedBindingsOf(decl), out, leftover, merged: false });
		}
		// Every declaration that moves to the same module (and kind) becomes one:
		// `import { AuthCognito as A } …-cognito` + `import { AuthCognitoErrors } …-cognito`
		// would otherwise be two imports of `@aws-blocks/bb-auth`.
		const hosts = new Map<string, PlannedImport>();
		for (const p of planned) {
			const clause = this.ts.isImportDeclaration(p.job.decl) ? p.job.decl.importClause : undefined;
			const movable =
				clause !== undefined &&
				clause.name === undefined &&
				p.named !== undefined &&
				p.job.newModule !== undefined &&
				p.job.newModule !== p.current &&
				p.out.length > 0;
			if (!movable) continue;
			const key = `${p.target}\0${clause.isTypeOnly ? 'type' : 'value'}`;
			const host = hosts.get(key);
			if (!host) {
				hosts.set(key, p);
				continue;
			}
			host.out.push(...p.out);
			p.out = [];
			p.merged = true;
		}
		for (const p of planned) this.queueImportJob(p);
	}

	private queueImportJob(p: PlannedImport): void {
		const { job, current, named, out, leftover } = p;
		const { decl } = job;
		const start = decl.getStart(this.sf);
		const end = decl.getEnd();
		if (named && out.length === 0 && leftover.length === 0) {
			if (job.specs.length === 0) {
				// Nothing to render: never write `import {  } from …`. Leave it for a person.
				this.todo(decl, IMPORT_TODOS.emptyImport);
				this.attention.push(`the import of ${current} names nothing; it was left as it is`);
				return;
			}
			// Every name moved into another declaration (or was dropped): remove this one.
			const lineEnd = this.text.indexOf('\n', end);
			const removeEnd = startsLine(this.text, start) && lineEnd !== -1 ? lineEnd + 1 : end;
			const removeStart = startsLine(this.text, start) ? lineStart(this.text, start) : start;
			this.jobs.push({ start: removeStart, end: removeEnd, run: () => '' });
			if (p.merged) this.changes.push(`${current} → ${p.target} (merged into one import)`);
			else this.changes.push(`removed import of ${current}`);
			return;
		}
		const render = (specs: readonly string[], module: string | undefined): string => {
			let t = this.text.slice(start, end);
			if (named) {
				const nStart = named.getStart(this.sf) - start;
				const nEnd = named.getEnd() - start;
				t = t.slice(0, nStart) + this.renderNamed(named, specs) + t.slice(nEnd);
			}
			if (module && module !== current) {
				t = t.replace(new RegExp(`(['"])${escapeRegExp(current)}\\1`), (_m, q: string) => `${q}${module}${q}`);
			}
			return t;
		};
		this.jobs.push({
			start,
			end,
			run: () => {
				const parts: string[] = [];
				// The names with no equivalent stay on the old module (first, under the TODO).
				if (leftover.length > 0) parts.push(render(leftover, undefined));
				if (out.length > 0 || !named) parts.push(render(out, job.newModule));
				return parts.join(`${this.nl}${indentAt(this.text, start)}`);
			},
		});
		if (job.newModule && job.newModule !== current && (out.length > 0 || !named)) {
			this.changes.push(`${current} → ${job.newModule}`);
		}
	}

	private namedBindingsOf(
		decl: TS.ImportDeclaration | TS.ExportDeclaration,
	): TS.NamedImports | TS.NamedExports | undefined {
		const { ts } = this;
		if (ts.isImportDeclaration(decl)) {
			const b = decl.importClause?.namedBindings;
			return b && ts.isNamedImports(b) ? b : undefined;
		}
		return decl.exportClause && ts.isNamedExports(decl.exportClause) ? decl.exportClause : undefined;
	}

	private renderSpec(s: ImportedSpec, goneTodos: string[]): string | null {
		const { rule } = s;
		if (!rule) return s.node.getText(this.sf);
		let name = s.imported;
		if (rule.role === 'factory' && rule.to === null) {
			// google() / customOidc() / cognitoFederated(): dropped once every call was converted.
			if (!this.hasUnconsumedReference(s.local)) {
				this.changes.push(`${s.imported}() → oidcProviders / socialProviders entry`);
				return null;
			}
			goneTodos.push(TODOS.removedProviderFactory(s.imported));
		} else if (rule.to === null) {
			if (rule.todo) goneTodos.push(rule.todo);
		} else if (typeof rule.to === 'string') {
			name = rule.to;
			if (rule.todo) goneTodos.push(rule.todo);
			if (name !== s.imported) this.changes.push(`${s.imported} → ${name}`);
		}
		const local = s.aliased ? s.local : (this.renames.get(s.local) ?? s.local);
		const alias = local !== name ? ` as ${local}` : '';
		return `${s.typeOnly ? 'type ' : ''}${name}${alias}`;
	}

	private renderNamed(named: TS.NamedImports | TS.NamedExports, specs: readonly string[]): string {
		const original = named.getText(this.sf);
		if (!original.includes('\n')) return `{ ${specs.join(', ')} }`;
		const indent = indentAt(this.text, named.elements[0]?.getStart(this.sf) ?? named.getStart(this.sf));
		const closing = indentAt(this.text, named.getEnd() - 1);
		return `{${this.nl}${specs.map((s) => `${indent}${s},`).join(this.nl)}${this.nl}${closing}}`;
	}

	private hasUnconsumedReference(local: string): boolean {
		let found = false;
		const visit = (node: TS.Node): void => {
			if (found) return;
			if (this.ts.isImportDeclaration(node)) return;
			if (this.ts.isIdentifier(node) && node.text === local) {
				const call = node.parent;
				if (
					!(this.ts.isCallExpression(call) && call.expression === node && this.consumedFactoryCalls.has(call))
				) {
					found = true;
				}
			}
			this.ts.forEachChild(node, visit);
		};
		visit(this.sf);
		return found;
	}

	// ── Instances ──────────────────────────────────────────────────────────

	private scanInstances(): void {
		const { ts } = this;
		const visit = (node: TS.Node): void => {
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
				const block = this.instanceBlockOf(node.initializer, node.type);
				if (block) this.instanceLocals.set(node.name.text, block);
			} else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
				const block = this.instanceBlockOf(undefined, node.type);
				if (block) this.instanceLocals.set(node.name.text, block);
			} else if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
				const block = this.instanceBlockOf(node.initializer, node.type);
				if (block) this.thisInstances.set(node.name.text, block);
			}
			ts.forEachChild(node, visit);
		};
		visit(this.sf);
	}

	private instanceBlockOf(init: TS.Expression | undefined, type: TS.TypeNode | undefined): OldBlock | undefined {
		const { ts } = this;
		if (init) {
			const n = unwrap(ts, init);
			if (ts.isNewExpression(n)) {
				const block = this.classBlockOf(n.expression);
				if (block) return block;
			}
		}
		if (type && ts.isTypeReferenceNode(type)) return this.classBlockOf(type.typeName);
		return undefined;
	}

	/** The old block a class reference names: an imported old class, or `blocks.AuthCognito`. */
	private classBlockOf(ref: TS.Expression | TS.EntityName): OldBlock | undefined {
		if (this.ts.isIdentifier(ref)) return this.classLocals.get(ref.text);
		const member = this.umbrellaMember(ref);
		return member?.rule.role === 'class' ? member.block : undefined;
	}

	/** The old block an errors-constant reference names: an imported one, or `blocks.AuthCognitoErrors`. */
	private errorsBlockOf(ref: TS.Expression): OldBlock | undefined {
		if (this.ts.isIdentifier(ref)) return this.errorsLocals.get(ref.text);
		const member = this.umbrellaMember(ref);
		return member?.rule.role === 'errors' ? member.block : undefined;
	}

	/**
	 * `blocks.<Name>` (or the type `blocks.<Name>`) on an `import * as blocks`
	 * of the umbrella, where `<Name>` is specific to an old block. The provider
	 * helpers `Auth` shares (`github`, `stubIdp`, `customOauth2`) are not.
	 */
	private umbrellaMember(node: TS.Node): { block: OldBlock; rule: NameRule; name: TS.Identifier } | undefined {
		const { ts } = this;
		if (this.umbrellaNamespaces.size === 0) return undefined;
		let left: TS.Node;
		let right: TS.Node;
		if (ts.isPropertyAccessExpression(node)) {
			left = node.expression;
			right = node.name;
		} else if (ts.isQualifiedName(node)) {
			left = node.left;
			right = node.right;
		} else return undefined;
		if (!ts.isIdentifier(left) || !this.umbrellaNamespaces.has(left.text) || !ts.isIdentifier(right))
			return undefined;
		if (SHARED_FACTORY_NAMES.has(right.text)) return undefined;
		const block = umbrellaBlockFor(right.text);
		const rule = block ? NAME_RULES[block][right.text] : undefined;
		return block && rule ? { block, rule, name: right } : undefined;
	}

	/** Rename `blocks.AuthCognito` → `blocks.Auth` (and every other old name reached through the namespace). */
	private handleUmbrellaMember(node: TS.PropertyAccessExpression | TS.QualifiedName): void {
		const member = this.umbrellaMember(node);
		if (!member) return;
		this.authTouching = true;
		const { rule, name } = member;
		if (rule.role === 'factory') return; // converted inside AuthOIDC's providers, or flagged at the call
		if (typeof rule.to === 'string' && rule.to !== name.text) {
			this.edit(name.getStart(this.sf), name.getEnd(), rule.to);
			const ns = (this.ts.isPropertyAccessExpression(node) ? node.expression : node.left).getText(this.sf);
			this.changes.push(`${ns}.${name.text} → ${ns}.${rule.to}`);
		}
		if (rule.todo) this.todo(node, rule.todo);
	}

	/** A use of an umbrella namespace the codemod can't follow (`blocks['AuthCognito']`, `const { AuthCognito } = blocks`). */
	private handleNamespaceUse(node: TS.Identifier): void {
		const { ts } = this;
		if (!this.umbrellaNamespaces.has(node.text)) return;
		const p = node.parent;
		if (ts.isPropertyAccessExpression(p) && p.expression === node) return;
		if (ts.isQualifiedName(p) && p.left === node) return;
		if (ts.isNamespaceImport(p)) return;
		if (!/\bAuth(?:Basic|Cognito|OIDC)\w*|\bCognitoUser\b|\bOIDCUser\b/.test(this.text)) return;
		this.authTouching = true;
		this.todo(node, IMPORT_TODOS.namespaceUse);
	}

	private receiverBlock(expr: TS.Expression): OldBlock | undefined {
		const { ts } = this;
		const e = unwrap(ts, expr);
		if (ts.isIdentifier(e)) return this.instanceLocals.get(e.text);
		if (ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword) {
			return this.thisInstances.get(e.name.text);
		}
		return undefined;
	}

	// ── The visitor ────────────────────────────────────────────────────────

	private visit(node: TS.Node): void {
		const { ts } = this;
		if (this.isProtected(node.getStart(this.sf))) {
			this.checkProtectedSpan(node);
			return;
		}
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			if (ts.isExportDeclaration(node) && !node.moduleSpecifier) this.visitChildren(node);
			return;
		}
		if (ts.isNewExpression(node)) {
			const block = this.classBlockOf(node.expression);
			if (block) this.handleConstruction(node, block);
		}
		if (ts.isQualifiedName(node)) this.handleUmbrellaMember(node);
		this.handleErrorKeyForms(node);
		if (ts.isCallExpression(node)) this.handleCall(node);
		if (ts.isPropertyAccessExpression(node)) this.handlePropertyAccess(node);
		if (ts.isIdentifier(node)) this.handleIdentifier(node);
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) this.handleString(node);
		this.visitChildren(node);
	}

	private visitChildren(node: TS.Node): void {
		this.ts.forEachChild(node, (child) => this.visit(child));
	}

	private isProtected(pos: number): boolean {
		return this.protectedRanges.some(([s, e]) => pos >= s && pos < e);
	}

	/** Inside a protected id span: edit nothing, but flag a reference to a renamed name. */
	private checkProtectedSpan(node: TS.Node): void {
		const { ts } = this;
		const visit = (n: TS.Node): void => {
			if (ts.isIdentifier(n) && (this.renames.has(n.text) || this.classLocals.has(n.text))) {
				this.todo(n, TODOS.idNotRewritten(n.text));
			}
			ts.forEachChild(n, visit);
		};
		visit(node);
	}

	private assertNotProtected(e: Edit): void {
		for (const [s, end] of this.protectedRanges) {
			if (e.start < end && e.end > s && !(e.start <= s && e.end >= end && this.preservesSpan(e, s, end))) {
				throw new IdPreservationError(
					`${this.fileName}: refusing to edit the scope/id argument at ${s}–${end} (${JSON.stringify(this.text.slice(s, end))}).`,
				);
			}
		}
	}

	/** A job that rewrites a whole call must still contain the protected span verbatim. */
	private preservesSpan(e: Edit, s: number, end: number): boolean {
		return e.text.includes(this.text.slice(s, end));
	}

	// ── Constructions ──────────────────────────────────────────────────────

	private handleConstruction(node: TS.NewExpression, block: OldBlock): void {
		const args = node.arguments ?? [];
		for (const arg of args.slice(0, 2)) this.protectedRanges.push([arg.getStart(this.sf), arg.getEnd()]);
		this.changes.push(`new ${node.expression.getText(this.sf)}(…) → new Auth(…) (id kept)`);
		if (node.typeArguments && node.typeArguments.length > 0) this.todo(node, TODOS.typeArguments);
		if (block === 'basic') this.todo(node, TODOS.authBasic);
		const options = args[2];
		if (!options) return;
		const obj = unwrap(this.ts, options);
		if (!this.ts.isObjectLiteralExpression(obj)) {
			this.todo(node, TODOS.optionsByReference);
			return;
		}
		if (block === 'oidc') this.markConsumedProviders(obj);
		const statement = node;
		this.jobs.push({
			start: obj.getStart(this.sf),
			end: obj.getEnd(),
			run: () => this.renderOptions(obj, block, statement),
		});
	}

	private markConsumedProviders(obj: TS.ObjectLiteralExpression): void {
		const providers = this.propOf(obj, 'providers');
		const value =
			providers && this.ts.isPropertyAssignment(providers) ? unwrap(this.ts, providers.initializer) : undefined;
		if (!value || !this.ts.isArrayLiteralExpression(value)) return;
		for (const el of value.elements) {
			const call = this.factoryCall(el);
			if (call) this.consumedFactoryCalls.add(call.call);
		}
	}

	private factoryCall(el: TS.Expression): { call: TS.CallExpression; factory: OidcFactory } | undefined {
		const { ts } = this;
		const e = unwrap(ts, el);
		if (!ts.isCallExpression(e)) return undefined;
		const factory = this.factoryOf(e.expression);
		if (!factory) return undefined;
		const arg = e.arguments[0];
		if (arg && !ts.isObjectLiteralExpression(unwrap(ts, arg))) return undefined;
		return { call: e, factory };
	}

	/** An `AuthOIDC` provider factory: an imported one, or `blocks.google` & co. */
	private factoryOf(callee: TS.Expression): OidcFactory | undefined {
		const { ts } = this;
		if (ts.isIdentifier(callee)) return this.factoryLocals.get(callee.text);
		if (
			ts.isPropertyAccessExpression(callee) &&
			ts.isIdentifier(callee.expression) &&
			this.umbrellaNamespaces.has(callee.expression.text)
		) {
			return NAME_RULES.oidc[callee.name.text]?.factory;
		}
		return undefined;
	}

	// ── Options objects ────────────────────────────────────────────────────

	private renderOptions(obj: TS.ObjectLiteralExpression, block: OldBlock, statement: TS.Node): string {
		const layout = this.layoutOf(obj);
		const top: OutEntry[] = [];
		const props = obj.properties;
		const { props: comments, closing } = this.propertyComments(obj);
		const carry = (i: number, cs: string[]): void => {
			const slot = comments[i];
			if (slot) slot.leading.unshift(...cs);
			else closing.unshift(...cs);
		};
		const place = (path: readonly string[], entry: OutEntry): void => {
			let list = top;
			for (const seg of path) {
				let group = list.find((e) => e.key === seg && e.value.t === 'obj');
				if (!group) {
					group = { key: seg, value: { t: 'obj', entries: [] }, comments: [], todos: [] };
					list.push(group);
				}
				if (group.value.t !== 'obj') break;
				list = group.value.entries;
			}
			list.push(entry);
		};
		if (block === 'oidc') place([], this.textEntry('emailPassword', 'false'));
		const handled = new Set<string>();
		props.forEach((prop, index) => {
			const c = comments[index] ?? { leading: [], trailing: undefined };
			// A TODO already anchored on this property's own line moves with the property.
			const anchorPos = lineStart(this.text, prop.getStart(this.sf));
			const anchored = anchorPos > obj.getStart(this.sf) ? this.anchors.get(anchorPos) : undefined;
			const carried: Todo[] = anchored && !anchored.consumed ? [...anchored.todos] : [];
			if (anchored) anchored.consumed = true;
			const key = propName(this.ts, prop);
			let placed: OutEntry | undefined;
			if (key === undefined || this.ts.isSpreadAssignment(prop)) {
				const todo = this.ts.isSpreadAssignment(prop)
					? TODOS.spreadOptions
					: TODOS.unknownOption(prop.getText(this.sf));
				placed = this.rawEntry(prop, c.leading, [todo, ...carried]);
				place([], placed);
			} else if (!handled.has(key)) {
				const mapped = this.mapOption(block, key, prop, obj, handled);
				const first = mapped[0];
				if (first) {
					first.entry.comments.unshift(...c.leading);
					first.entry.todos.push(...carried);
				} else {
					for (const t of carried) this.todo(statement, t);
					// Dropped option: keep its comments on the next entry rather than losing them.
					carry(index + 1, c.leading);
				}
				for (const m of mapped) place(m.path, m.entry);
				placed = mapped[mapped.length - 1]?.entry;
			} else {
				// Folded into an earlier entry (mfaTypes into mfa, …): its comments go there too.
				placed = undefined;
				if (c.leading.length > 0) carry(index + 1, c.leading);
			}
			if (c.trailing) {
				if (placed && placed.trailing === undefined) placed.trailing = c.trailing;
				else carry(index + 1, [c.trailing]);
			}
		});
		const hoisted: Todo[] = [];
		const out = this.renderObject(top, this.closingIndent(obj), layout, hoisted, closing);
		for (const t of hoisted) this.todo(statement, t);
		this.changes.push('options mapped to the Auth shape');
		return out;
	}

	private mapOption(
		block: OldBlock,
		key: string,
		prop: TS.ObjectLiteralElementLike,
		obj: TS.ObjectLiteralExpression,
		handled: Set<string>,
	): { path: string[]; entry: OutEntry }[] {
		const simple = SIMPLE_OPTIONS[block][key];
		if (simple) {
			const path = simple.slice(0, -1);
			const newKey = simple[simple.length - 1] ?? key;
			const entry = this.movedEntry(prop, newKey);
			if (block === 'basic' && key === 'codeDelivery') entry.todos.push(TODOS.basicCodeDelivery);
			if (block === 'basic' && key === 'passwordPolicy') this.renameSpecialChars(prop, entry);
			if (block === 'oidc' && (key === 'onSignIn' || key === 'onSignOut')) this.flagOidcUserFields(prop, entry);
			if (block === 'cognito' && key === 'preferredChallenge' && !this.propOf(obj, 'userPool')) {
				if (literalOf(this.ts, valueNode(this.ts, prop)) === 'EMAIL_OTP') {
					entry.todos.push(TODOS.emailOtpNeedsSes);
					this.warnings.add('emailOtpOwnPool');
				}
			}
			if (block === 'cognito' && key === 'authFlowType') {
				const lit = literalOf(this.ts, valueNode(this.ts, prop));
				if (lit !== undefined && lit !== 'USER_PASSWORD_AUTH' && lit !== 'USER_AUTH') {
					entry.todos.push(TODOS.authFlowUnsupported);
				}
			}
			return [{ path, entry }];
		}
		if (block === 'cognito') {
			if (key === 'signInWith') return [{ path: ['users'], entry: this.signInWithEntry(prop) }];
			if (key === 'mfa' || key === 'mfaTypes') {
				handled.add('mfa');
				handled.add('mfaTypes');
				return [{ path: [], entry: this.mfaEntry(obj) }];
			}
			if (key === 'enablePasskeys' || key === 'webAuthnRelyingParty') {
				handled.add('enablePasskeys');
				handled.add('webAuthnRelyingParty');
				return this.passkeysEntries(obj);
			}
		}
		if (block === 'oidc' && key === 'providers') return this.providerEntries(prop);
		return [{ path: [], entry: this.rawEntry(prop, [], [TODOS.unknownOption(key)]) }];
	}

	/** An entry for `prop` under `newKey`, value text taken from the source (with inner edits). */
	private movedEntry(prop: TS.ObjectLiteralElementLike, newKey: string): OutEntry {
		const { ts } = this;
		if (ts.isMethodDeclaration(prop)) {
			const nameNode = prop.name;
			const text = this.slice(
				prop.getStart(this.sf),
				prop.getEnd(),
				nameNode.getText(this.sf) !== newKey
					? [{ start: nameNode.getStart(this.sf), end: nameNode.getEnd(), text: newKey }]
					: [],
			);
			return {
				key: null,
				value: { t: 'text', text, indent: indentAt(this.text, prop.getStart(this.sf)) },
				comments: [],
				todos: [],
			};
		}
		if (ts.isShorthandPropertyAssignment(prop)) {
			const name = prop.name.text;
			return name === newKey ? this.textEntry(null, name) : this.textEntry(newKey, name);
		}
		const value = valueNode(ts, prop);
		if (!value) return this.rawEntry(prop, [], []);
		const keyText =
			ts.isPropertyAssignment(prop) && propName(ts, prop) === newKey
				? prop.name.getText(this.sf)
				: keyOf(newKey, this.quote);
		return {
			key: keyText,
			value: {
				t: 'text',
				text: this.slice(value.getStart(this.sf), value.getEnd()),
				indent: indentAt(this.text, prop.getStart(this.sf)),
			},
			comments: [],
			todos: [],
		};
	}

	private textEntry(key: string | null, text: string): OutEntry {
		return { key, value: { t: 'text', text, indent: '' }, comments: [], todos: [] };
	}

	private rawEntry(prop: TS.Node, comments: string[], todos: Todo[]): OutEntry {
		return {
			key: null,
			value: {
				t: 'text',
				text: this.slice(prop.getStart(this.sf), prop.getEnd()),
				indent: indentAt(this.text, prop.getStart(this.sf)),
			},
			comments: [...comments],
			todos: [...todos],
		};
	}

	private renameSpecialChars(prop: TS.ObjectLiteralElementLike, entry: OutEntry): void {
		const { ts } = this;
		const value = valueNode(ts, prop);
		const obj = value ? unwrap(ts, value) : undefined;
		if (!value || !obj || !ts.isObjectLiteralExpression(obj)) {
			entry.todos.push(TODOS.passwordPolicyByRef);
			return;
		}
		const extra: Edit[] = [];
		for (const p of obj.properties) {
			if (propName(ts, p) !== 'requireSpecialChars') continue;
			if (ts.isShorthandPropertyAssignment(p)) {
				extra.push({
					start: p.getStart(this.sf),
					end: p.getEnd(),
					text: 'requireSymbols: requireSpecialChars',
				});
			} else if (ts.isPropertyAssignment(p)) {
				extra.push({ start: p.name.getStart(this.sf), end: p.name.getEnd(), text: 'requireSymbols' });
			}
		}
		if (extra.length === 0) return;
		this.changes.push('passwordPolicy.requireSpecialChars → requireSymbols');
		entry.value = {
			t: 'text',
			text: this.slice(value.getStart(this.sf), value.getEnd(), extra),
			indent: indentAt(this.text, prop.getStart(this.sf)),
		};
	}

	private flagOidcUserFields(prop: TS.ObjectLiteralElementLike, entry: OutEntry): void {
		const { ts } = this;
		const fn = ts.isMethodDeclaration(prop) ? prop : valueNode(ts, prop);
		if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn))) return;
		const param = fn.parameters[0];
		if (!param || !ts.isIdentifier(param.name)) return;
		const name = param.name.text;
		const fields = new Set<string>();
		const visit = (n: TS.Node): void => {
			if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
				if (['claims', 'iss', 'sub', 'provider', 'email', 'name'].includes(n.name.text))
					fields.add(n.name.text);
			}
			ts.forEachChild(n, visit);
		};
		if (fn.body) visit(fn.body);
		for (const f of fields) entry.todos.push(f === 'claims' ? TODOS.oidcUserClaims : TODOS.oidcUserField(f));
	}

	private signInWithEntry(prop: TS.ObjectLiteralElementLike): OutEntry {
		const { ts } = this;
		const value = valueNode(ts, prop);
		const entry = this.movedEntry(prop, 'signInWith');
		if (!value) return entry;
		const inner = unwrap(ts, value);
		if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
			entry.value = { t: 'text', text: `[${inner.getText(this.sf)}]`, indent: '' };
			if (entry.key === null) entry.key = 'signInWith';
		} else if (!ts.isArrayLiteralExpression(inner)) {
			entry.todos.push(TODOS.signInWithByRef);
		}
		return entry;
	}

	private mfaEntry(obj: TS.ObjectLiteralExpression): OutEntry {
		const { ts } = this;
		const mfa = this.propOf(obj, 'mfa');
		const types = this.propOf(obj, 'mfaTypes');
		const mfaValue = mfa ? valueNode(ts, mfa) : undefined;
		const typesValue = types ? valueNode(ts, types) : undefined;
		const modeText = mfaValue
			? this.slice(mfaValue.getStart(this.sf), mfaValue.getEnd())
			: `${this.quote}off${this.quote}`;
		const mode = mfaValue ? literalOf(ts, mfaValue) : 'off';
		if (!typesValue && mode === 'off') {
			const entry = mfa ? this.movedEntry(mfa, 'mfa') : this.textEntry('mfa', modeText);
			return entry;
		}
		// R10: AuthCognito with MFA on and no mfaTypes enabled SMS only; Auth defaults to SMS + TOTP.
		const typesText = typesValue
			? this.slice(typesValue.getStart(this.sf), typesValue.getEnd())
			: `[${this.quote}SMS${this.quote}]`;
		if (!typesValue) this.changes.push("mfa: explicit types ['SMS'] (AuthCognito's default)");
		return {
			key: 'mfa',
			value: {
				t: 'obj',
				inline: true,
				entries: [this.textEntry('mode', modeText), this.textEntry('types', typesText)],
			},
			comments: types && !mfa ? [] : [],
			todos: [],
		};
	}

	private passkeysEntries(obj: TS.ObjectLiteralExpression): { path: string[]; entry: OutEntry }[] {
		const { ts } = this;
		const enable = this.propOf(obj, 'enablePasskeys');
		const rp = this.propOf(obj, 'webAuthnRelyingParty');
		const enableValue = enable ? valueNode(ts, enable) : undefined;
		const rpValue = rp ? valueNode(ts, rp) : undefined;
		const enabledLiteral = unwrapKind(ts, enableValue) === ts.SyntaxKind.TrueKeyword;
		const disabledLiteral = !enableValue || unwrapKind(ts, enableValue) === ts.SyntaxKind.FalseKeyword;
		if (disabledLiteral) return rp ? this.droppedWithTodo(TODOS.passkeysDisabledRp) : [];
		if (!rpValue) return this.droppedWithTodo(TODOS.passkeysNeedRp);
		const rpObj = unwrap(ts, rpValue);
		if (!ts.isObjectLiteralExpression(rpObj)) {
			const text = this.slice(rpValue.getStart(this.sf), rpValue.getEnd());
			const entry = this.textEntry(
				'passkeys',
				enabledLiteral
					? text
					: `${this.slice(enableValue?.getStart(this.sf) ?? 0, enableValue?.getEnd() ?? 0)} ? ${text} : false`,
			);
			entry.todos.push(TODOS.passkeysRpByRef);
			return [{ path: [], entry }];
		}
		const entries: OutEntry[] = [];
		for (const p of rpObj.properties) {
			const k = propName(ts, p);
			const v = valueNode(ts, p);
			const vText = v
				? this.slice(v.getStart(this.sf), v.getEnd())
				: ts.isShorthandPropertyAssignment(p)
					? p.name.text
					: p.getText(this.sf);
			if (k === 'id') entries.push(this.textEntry('relyingPartyId', vText));
			else if (k === 'origins') entries.push(this.textEntry('origins', vText));
			else if (k === 'userVerification') {
				const lit = v ? literalOf(ts, v) : undefined;
				if (lit === 'discouraged') {
					entries.push(this.textEntry('userVerification', `${this.quote}preferred${this.quote}`));
					this.changes.push(
						"passkeys.userVerification 'discouraged' → 'preferred' (what AuthCognito applied)",
					);
				} else entries.push(this.textEntry('userVerification', vText));
			} else entries.push({ ...this.rawEntry(p, [], [TODOS.unknownOption(k ?? p.getText(this.sf))]) });
		}
		const objValue: OutValue = { t: 'obj', entries };
		if (enabledLiteral) return [{ path: [], entry: { key: 'passkeys', value: objValue, comments: [], todos: [] } }];
		// enablePasskeys is an expression: keep the condition.
		const cond = enableValue ? this.slice(enableValue.getStart(this.sf), enableValue.getEnd()) : 'false';
		const rendered = `${cond} ? ${this.renderInline(entries)} : false`;
		return [{ path: [], entry: this.textEntry('passkeys', rendered) }];
	}

	private droppedWithTodo(todo: Todo): { path: string[]; entry: OutEntry }[] {
		return [
			{ path: [], entry: { key: null, value: { t: 'text', text: '', indent: '' }, comments: [], todos: [todo] } },
		];
	}

	// ── AuthOIDC providers ─────────────────────────────────────────────────

	private providerEntries(prop: TS.ObjectLiteralElementLike): { path: string[]; entry: OutEntry }[] {
		const { ts } = this;
		const value = valueNode(ts, prop);
		const arr = value ? unwrap(ts, value) : undefined;
		if (!value || !arr || !ts.isArrayLiteralExpression(arr)) {
			const entry = this.movedEntry(prop, 'providers');
			entry.todos.push(TODOS.providersNotArray);
			return [{ path: [], entry }];
		}
		const out: { path: string[]; entry: OutEntry }[] = [];
		const leftovers: string[] = [];
		let domainTodoDone = false;
		for (const el of arr.elements) {
			const fc = this.factoryCall(el);
			const comments = this.leadingComments(el);
			if (!fc) {
				leftovers.push(this.slice(el.getStart(this.sf), el.getEnd()));
				continue;
			}
			const converted = this.convertProvider(fc.call, fc.factory);
			converted.entry.comments.unshift(...comments);
			if (fc.factory === 'cognitoFederated' && !domainTodoDone) {
				converted.entry.todos.unshift(TODOS.domain);
				domainTodoDone = true;
			}
			out.push(converted);
		}
		if (leftovers.length > 0) {
			const entry = this.textEntry('providers', `[${leftovers.join(', ')}]`);
			entry.todos.push(TODOS.providerNotFactory);
			out.push({ path: [], entry });
		}
		return out;
	}

	private convertProvider(call: TS.CallExpression, factory: OidcFactory): { path: string[]; entry: OutEntry } {
		const { ts } = this;
		const arg = call.arguments[0];
		const opts = arg ? unwrap(ts, arg) : undefined;
		const props = new Map<string, TS.ObjectLiteralElementLike>();
		if (opts && ts.isObjectLiteralExpression(opts)) {
			for (const p of opts.properties) {
				const k = propName(ts, p);
				if (k !== undefined) props.set(k, p);
			}
		}
		const todos: Todo[] = [];
		const entries: OutEntry[] = [];
		const used = new Set<string>(['name']);
		const take = (
			oldKey: string,
			newKey = oldKey,
			convert?: (n: TS.Expression) => { text: string; todo?: Todo },
		): void => {
			const p = props.get(oldKey);
			if (!p) return;
			used.add(oldKey);
			const v = valueNode(ts, p) ?? (ts.isShorthandPropertyAssignment(p) ? p.name : undefined);
			if (!v) return;
			const conv = convert ? convert(v) : { text: this.slice(v.getStart(this.sf), v.getEnd()) };
			const entry =
				conv.text === newKey && ts.isShorthandPropertyAssignment(p)
					? this.textEntry(null, newKey)
					: this.textEntry(newKey, conv.text);
			entry.value = { t: 'text', text: conv.text, indent: indentAt(this.text, p.getStart(this.sf)) };
			entry.comments.push(...this.leadingComments(p));
			if (conv.todo) entry.todos.push(conv.todo);
			entries.push(entry);
		};
		const rest = (): void => {
			for (const [k, p] of props) {
				if (used.has(k)) continue;
				entries.push(this.rawEntry(p, this.leadingComments(p), [TODOS.unknownOption(k)]));
			}
		};
		const nameKey = (): string => {
			const p = props.get('name');
			const v = p ? valueNode(ts, p) : undefined;
			const lit = v ? literalOf(ts, v) : undefined;
			if (lit !== undefined) return keyOf(lit, this.quote);
			todos.push(TODOS.providerName);
			return `[${v ? this.slice(v.getStart(this.sf), v.getEnd()) : 'name'}]`;
		};
		const secret = (n: TS.Expression) => this.convertSecret(n);
		const clientId = (n: TS.Expression) => this.convertClientId(n);
		const record = (group: string, key: string, value: OutValue): { path: string[]; entry: OutEntry } => ({
			path: [group],
			entry: { key, value, comments: [], todos },
		});
		const q = this.quote;
		switch (factory) {
			case 'google': {
				entries.push(this.textEntry('issuer', `${q}https://accounts.google.com${q}`));
				take('clientId', 'clientId', clientId);
				take('clientSecret', 'clientSecret', secret);
				take('scopes');
				rest();
				this.changes.push('google() → oidcProviders.google (direct; userId unchanged)');
				return record('oidcProviders', 'google', { t: 'obj', entries });
			}
			case 'github': {
				take('clientId', 'clientId', clientId);
				take('clientSecret', 'clientSecret', secret);
				take('scopes');
				rest();
				return record('oidcProviders', 'github', {
					t: 'call',
					callee: this.calleeText(call),
					arg: { t: 'obj', entries },
				});
			}
			case 'customOidc': {
				const key = nameKey();
				take('issuerUrl', 'issuer');
				take('clientId', 'clientId', clientId);
				take('clientSecret', 'clientSecret', secret);
				take('scopes');
				take('attributeMapping');
				rest();
				this.changes.push('customOidc() → oidcProviders entry (direct; userId unchanged)');
				return record('oidcProviders', key, { t: 'obj', entries });
			}
			case 'customOauth2': {
				const key = nameKey();
				take('name');
				take('clientId', 'clientId', clientId);
				take('clientSecret', 'clientSecret', secret);
				const endpoints: OutEntry[] = [];
				for (const [from, to] of [
					['authUrl', 'authorization'],
					['tokenUrl', 'token'],
					['userInfoUrl', 'userInfo'],
				] as const) {
					const p = props.get(from);
					used.add(from);
					const v = p
						? (valueNode(ts, p) ?? (ts.isShorthandPropertyAssignment(p) ? p.name : undefined))
						: undefined;
					if (v) endpoints.push(this.textEntry(to, this.slice(v.getStart(this.sf), v.getEnd())));
				}
				entries.push({ key: 'endpoints', value: { t: 'obj', entries: endpoints }, comments: [], todos: [] });
				take('scopes');
				take('mapClaims');
				rest();
				return record('oidcProviders', key, {
					t: 'call',
					callee: this.calleeText(call),
					arg: { t: 'obj', entries },
				});
			}
			case 'stubIdp': {
				const key = nameKey();
				take('scopes');
				take('onAuthorize');
				take('users');
				rest();
				// AuthOIDC served the stub from deployed stacks too; Auth refuses it at
				// synth without the opt-in. Keep the deployed behaviour (so "deploy the
				// output unchanged" holds), loudly.
				entries.push({
					key: 'unsafeAllowDeployed',
					value: { t: 'text', text: 'true', indent: '' },
					comments: [],
					todos: [TODOS.stubIdpDeployed],
				});
				this.changes.push(
					'stubIdp() → unsafeAllowDeployed: true (AuthOIDC deployed the stub; review the TODO)',
				);
				return record('oidcProviders', key, {
					t: 'call',
					callee: this.calleeText(call),
					arg: { t: 'obj', entries },
				});
			}
			case 'cognitoFederated': {
				used.add('cognitoDomain');
				used.add('region');
				used.add('identityProvider');
				todos.push(TODOS.cognitoFederatedRekey);
				const idpProp = props.get('identityProvider');
				const idpValue = idpProp ? valueNode(ts, idpProp) : undefined;
				const idp = idpValue ? literalOf(ts, idpValue) : undefined;
				const social = idp ? SOCIAL_IDPS[idp] : undefined;
				const nameProp = props.get('name');
				const nameValue = nameProp ? valueNode(ts, nameProp) : undefined;
				const nameLit = nameValue ? literalOf(ts, nameValue) : undefined;
				if (social) {
					take('clientId', 'clientId', () => ({
						text: this.valueText(props.get('clientId')),
						todo: TODOS.clientIdNotString,
					}));
					if (social === 'apple') {
						todos.push(TODOS.apple);
						take('clientSecret', 'privateKey');
					} else take('clientSecret');
					take('scopes');
					rest();
					if (nameLit !== undefined && nameLit !== social) todos.push(TODOS.socialRenamed(nameLit, social));
					this.changes.push(`cognitoFederated(${idp}) → socialProviders.${social}`);
					return record('socialProviders', social, { t: 'obj', entries });
				}
				const key = nameKey();
				entries.push(this.textEntry('federateVia', `${q}cognito${q}`));
				take('idpIssuerUrl', 'issuer');
				take('clientId', 'clientId', () => ({
					text: this.valueText(props.get('clientId')),
					todo: TODOS.clientIdNotString,
				}));
				take('clientSecret');
				take('scopes');
				rest();
				this.changes.push("cognitoFederated() → oidcProviders entry with federateVia: 'cognito'");
				return record('oidcProviders', key, { t: 'obj', entries });
			}
		}
	}

	private calleeText(call: TS.CallExpression): string {
		return this.slice(call.expression.getStart(this.sf), call.expression.getEnd());
	}

	private valueText(p: TS.ObjectLiteralElementLike | undefined): string {
		if (!p) return '';
		const v = valueNode(this.ts, p);
		if (v) return this.slice(v.getStart(this.sf), v.getEnd());
		return this.ts.isShorthandPropertyAssignment(p) ? p.name.text : p.getText(this.sf);
	}

	/** `() => setting.get()` → `setting`; anything else is kept with a TODO. */
	private convertSecret(n: TS.Expression): { text: string; todo?: Todo } {
		const { ts } = this;
		const target = getterTarget(ts, n);
		if (target) {
			this.changes.push('provider secret: () => setting.get() → setting (AppSetting reference)');
			return { text: this.slice(target.getStart(this.sf), target.getEnd()) };
		}
		return { text: this.slice(n.getStart(this.sf), n.getEnd()), todo: TODOS.secretNotAppSetting };
	}

	private convertClientId(n: TS.Expression): { text: string; todo?: Todo } {
		const text = this.slice(n.getStart(this.sf), n.getEnd());
		const inner = unwrap(this.ts, n);
		if (this.ts.isArrowFunction(inner) || this.ts.isFunctionExpression(inner))
			return { text, todo: TODOS.clientIdNotString };
		return { text };
	}

	// ── Calls, property accesses, identifiers, strings ─────────────────────

	private handleCall(node: TS.CallExpression): void {
		const { ts } = this;
		const callee = node.expression;
		// import('@aws-blocks/bb-auth-cognito') / require(...)
		if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
			const spec = moduleText(ts, node.arguments[0]);
			if (spec && (OLD_MODULES[spec] || DEAD_SUBPATHS[spec] || OLD_SUBPATHS[spec])) {
				this.authTouching = true;
				this.todo(node, TODOS.dynamicImport);
			}
			return;
		}
		const fnName = ts.isIdentifier(callee)
			? callee.text
			: ts.isPropertyAccessExpression(callee)
				? callee.name.text
				: undefined;
		if (fnName && ERROR_CHECK_FUNCTIONS.has(fnName) && this.project.blocks.size > 0)
			this.handleErrorCheck(node, fnName);
		if (ts.isIdentifier(callee) && this.factoryLocals.has(callee.text) && !this.consumedFactoryCalls.has(node)) {
			this.todo(node, TODOS.providerNotFactory);
		}
		const member = this.umbrellaMember(callee);
		if (member?.rule.role === 'factory' && member.rule.to === null && !this.consumedFactoryCalls.has(node)) {
			this.todo(node, TODOS.removedProviderFactory(member.name.text));
		}
		if (!ts.isPropertyAccessExpression(callee)) return;
		const method = callee.name.text;
		const block = this.receiverBlock(callee.expression);
		if (!block) {
			if (this.authTouching && DISTINCTIVE_OLD_METHODS.has(method)) {
				const to = COGNITO_METHOD_RENAMES[method] ?? 'updateUserAttributes';
				this.todo(node, TODOS.unknownReceiver(method, to));
			}
			if (method === 'getClient' && node.arguments.length === 0 && this.project.blocks.has('oidc')) {
				this.todo(node, TODOS.getClient);
			}
			return;
		}
		if (block === 'cognito') this.handleCognitoCall(node, callee, method);
		if (block === 'basic') {
			if (method === 'buildApi') this.todo(node, TODOS.buildApi);
			if (method === 'signIn' && this.resultUsed(node)) this.todo(node, TODOS.basicSignInResult);
		}
		if (block === 'oidc') {
			const gone = OIDC_GONE_MEMBERS[method];
			if (gone) this.todo(node, gone);
		}
	}

	private handleCognitoCall(node: TS.CallExpression, callee: TS.PropertyAccessExpression, method: string): void {
		const { ts } = this;
		const renamed = COGNITO_METHOD_RENAMES[method];
		if (renamed) {
			this.edit(callee.name.getStart(this.sf), callee.name.getEnd(), renamed);
			this.changes.push(`${method}() → ${renamed}()`);
			return;
		}
		const args = node.arguments;
		if (method === 'updateUserAttribute') {
			const [ctx, name, value] = args;
			if (args.length !== 3 || !ctx || !name || !value || args.some((a) => ts.isSpreadElement(a))) {
				this.todo(node, TODOS.updateUserAttributeByRef);
				return;
			}
			const lit = literalOf(ts, name);
			this.edit(callee.name.getStart(this.sf), callee.name.getEnd(), 'updateUserAttributes');
			const start = name.getStart(this.sf);
			const end = value.getEnd();
			this.jobs.push({
				start,
				end,
				run: () => {
					const key = lit !== undefined ? keyOf(lit, this.quote) : `[${this.slice(start, name.getEnd())}]`;
					return `{ ${key}: ${this.slice(value.getStart(this.sf), end)} }`;
				},
			});
			this.changes.push('updateUserAttribute(ctx, name, value) → updateUserAttributes(ctx, { name: value })');
			if (this.resultUsed(node)) this.todo(node, TODOS.updateUserAttributeResult);
			return;
		}
		if (method === 'confirmSignIn') {
			const response = args[1];
			const obj = response ? unwrap(ts, response) : undefined;
			if (!obj || !ts.isObjectLiteralExpression(obj)) return;
			const only = obj.properties.length === 1 ? obj.properties[0] : undefined;
			const key = only ? propName(ts, only) : undefined;
			if (!only || !key || !CONFIRM_SIGN_IN_KEYS.has(key) || !response) {
				this.todo(node, TODOS.confirmSignInObject);
				return;
			}
			const start = response.getStart(this.sf);
			const end = response.getEnd();
			this.jobs.push({ start, end, run: () => this.valueText(only) });
			this.changes.push(`confirmSignIn(session, { ${key} }) → confirmSignIn(session, ${key})`);
			return;
		}
		if (method === 'signUp') {
			const opts = args[2];
			const obj = opts ? unwrap(ts, opts) : undefined;
			if (!opts || !obj || !ts.isObjectLiteralExpression(obj)) return;
			const auto = obj.properties.find((p) => propName(ts, p) === 'autoSignIn');
			if (!auto) return;
			const v = valueNode(ts, auto);
			if (!v || unwrapKind(ts, v) !== ts.SyntaxKind.TrueKeyword) {
				this.todo(node, TODOS.signUpAutoSignIn);
				return;
			}
			this.removeProperty(obj, auto, opts, args, 2);
			this.changes.push('signUp(…, { autoSignIn: true }) → emailPassword.autoSignIn (the default)');
			return;
		}
		if (method === 'signIn') {
			const opts = args[3];
			const obj = opts ? unwrap(ts, opts) : undefined;
			if (
				obj &&
				ts.isObjectLiteralExpression(obj) &&
				obj.properties.some((p) => propName(ts, p) === 'cognitoSession')
			) {
				this.todo(node, TODOS.cognitoSession);
			}
		}
	}

	/** Remove one property; drop the whole argument when it was the last one and is now empty. */
	private removeProperty(
		obj: TS.ObjectLiteralExpression,
		prop: TS.ObjectLiteralElementLike,
		arg: TS.Expression,
		args: TS.NodeArray<TS.Expression>,
		index: number,
	): void {
		const props = obj.properties;
		if (props.length === 1) {
			const prev = args[index - 1];
			if (index === args.length - 1 && prev && arg === obj) {
				this.jobs.push({ start: prev.getEnd(), end: arg.getEnd(), run: () => '' });
			} else {
				this.jobs.push({ start: obj.getStart(this.sf), end: obj.getEnd(), run: () => '{}' });
			}
			return;
		}
		const i = props.indexOf(prop);
		const next = props[i + 1];
		const prevProp = props[i - 1];
		if (next) this.jobs.push({ start: prop.getStart(this.sf), end: next.getStart(this.sf), run: () => '' });
		else if (prevProp) this.jobs.push({ start: prevProp.getEnd(), end: prop.getEnd(), run: () => '' });
	}

	private resultUsed(node: TS.CallExpression): boolean {
		const { ts } = this;
		let n: TS.Node = node;
		while (
			ts.isParenthesizedExpression(n.parent) ||
			ts.isAwaitExpression(n.parent) ||
			ts.isVoidExpression(n.parent)
		) {
			if (ts.isVoidExpression(n.parent)) return false;
			n = n.parent;
		}
		return !ts.isExpressionStatement(n.parent);
	}

	private handleErrorCheck(node: TS.CallExpression, fnName: string): void {
		const { ts } = this;
		const nameArg = node.arguments[1];
		let related = fnName === 'hasAuthError';
		if (nameArg) {
			const n = unwrap(ts, nameArg);
			if (ts.isPropertyAccessExpression(n)) {
				if (this.errorsBlockOf(n.expression)) related = true;
				if (ts.isIdentifier(n.expression) && this.newErrorsLocals.has(n.expression.text)) related = true;
			}
			if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && AUTH_ERROR_NAMES.has(n.text))
				related = true;
		}
		if (related) this.todo(node, ERROR_CHECK_TODO);
	}

	private handlePropertyAccess(node: TS.PropertyAccessExpression): void {
		const { ts } = this;
		this.handleUmbrellaMember(node);
		// <Old>Errors.<key> (or blocks.<Old>Errors.<key>)
		const errorsBlock = this.errorsBlockOf(node.expression);
		if (errorsBlock) {
			const rule = ERROR_KEY_RULES[errorsBlock][node.name.text];
			if (rule && rule.to !== node.name.text) {
				this.edit(node.name.getStart(this.sf), node.name.getEnd(), rule.to);
				this.changes.push(`${node.expression.getText(this.sf)}.${node.name.text} → AuthErrors.${rule.to}`);
			}
			if (rule?.split) this.todo(node, rule.split);
		}
		// AuthOIDC getters read without a call.
		if (ts.isCallExpression(node.parent) && node.parent.expression === node) return;
		const block = this.receiverBlock(node.expression);
		if (block === 'oidc') {
			const gone = OIDC_GONE_MEMBERS[node.name.text];
			if (gone) this.todo(node, gone);
		}
	}

	/** The old block an errors-constant entity names in a type: `AuthBasicErrors` or `blocks.AuthBasicErrors`. */
	private errorsBlockOfEntity(ref: TS.EntityName): OldBlock | undefined {
		if (this.ts.isIdentifier(ref)) return this.errorsLocals.get(ref.text);
		const member = this.umbrellaMember(ref);
		return member?.rule.role === 'errors' ? member.block : undefined;
	}

	/** Rename one `<Old>Errors` key node to its `AuthErrors` key (and leave the split TODO), as for `X.Errors.Key`. */
	private renameErrorKey(
		block: OldBlock,
		keyNode: TS.Node,
		key: string,
		at: TS.Node,
		edit: (to: string) => string,
	): void {
		const rule = ERROR_KEY_RULES[block][key];
		if (!rule) return;
		if (rule.to !== key) {
			this.edit(keyNode.getStart(this.sf), keyNode.getEnd(), edit(rule.to));
			this.changes.push(`${key} → AuthErrors.${rule.to}`);
		}
		if (rule.split) this.todo(at, rule.split);
	}

	/**
	 * The other ways code names an `<Old>Errors` key, whether the constant was
	 * imported by name or reached through an umbrella namespace (`blocks.…`):
	 * `typeof X.Errors.Key`, `X.Errors['Key']` and `const { Key } = X.Errors`.
	 * Without this the constant was renamed but the key kept, naming an
	 * `AuthErrors` member that does not exist (`AuthErrors.InvalidCode`).
	 */
	private handleErrorKeyForms(node: TS.Node): void {
		const { ts } = this;
		if (ts.isQualifiedName(node)) {
			const block = this.errorsBlockOfEntity(node.left);
			if (block) this.renameErrorKey(block, node.right, node.right.text, node, (to) => to);
			return;
		}
		if (ts.isElementAccessExpression(node)) {
			const arg = node.argumentExpression;
			if (!ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) return;
			const block = this.errorsBlockOf(node.expression);
			if (!block) return;
			const raw = arg.getText(this.sf);
			const q = raw[0] ?? this.quote;
			this.renameErrorKey(block, arg, arg.text, node, (to) => `${q}${to}${q}`);
			return;
		}
		if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
			const block = this.errorsBlockOf(unwrap(ts, node.initializer));
			if (!block) return;
			for (const el of node.name.elements) {
				if (el.dotDotDotToken) continue;
				if (el.propertyName) {
					const pn = el.propertyName;
					if (ts.isIdentifier(pn) || ts.isStringLiteral(pn)) {
						this.renameErrorKey(block, pn, pn.text, node, (to) => to);
					}
				} else if (ts.isIdentifier(el.name)) {
					const local = el.name.text;
					this.renameErrorKey(block, el.name, local, node, (to) => `${to}: ${local}`);
				}
			}
		}
	}

	private handleIdentifier(node: TS.Identifier): void {
		const { ts } = this;
		this.handleNamespaceUse(node);
		const to = this.renames.get(node.text);
		if (!to) return;
		const p = node.parent;
		if (ts.isPropertyAccessExpression(p) && p.name === node) return;
		if (ts.isQualifiedName(p) && p.right === node) return;
		if (
			(ts.isPropertyAssignment(p) ||
				ts.isPropertyDeclaration(p) ||
				ts.isPropertySignature(p) ||
				ts.isMethodDeclaration(p)) &&
			p.name === node
		)
			return;
		if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return;
		if (
			(ts.isVariableDeclaration(p) ||
				ts.isParameter(p) ||
				ts.isFunctionDeclaration(p) ||
				ts.isClassDeclaration(p) ||
				ts.isBindingElement(p)) &&
			p.name === node
		) {
			return;
		}
		if (ts.isShorthandPropertyAssignment(p)) {
			this.edit(node.getStart(this.sf), node.getEnd(), `${node.text}: ${to}`);
			return;
		}
		this.edit(node.getStart(this.sf), node.getEnd(), to);
	}

	private handleString(node: TS.StringLiteral | TS.NoSubstitutionTemplateLiteral): void {
		const { ts } = this;
		const p = node.parent;
		if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return;
		if (ts.isLiteralTypeNode(p) && ts.isImportTypeNode(p.parent)) return;
		if (this.project.blocks.has('basic')) {
			const rule = BASIC_STRING_RENAMES[node.text];
			if (rule) {
				const raw = node.getText(this.sf);
				const q = raw[0] ?? this.quote;
				this.edit(node.getStart(this.sf), node.getEnd(), `${q}${rule.to}${q}`);
				this.changes.push(`'${node.text}' → '${rule.to}'`);
				if (rule.split) this.todo(node, rule.split);
			}
		}
		if (this.project.blocks.has('oidc') && node.text === OIDC_ENGINE_ERROR) this.todo(node, OIDC_ENGINE_ERROR_TODO);
	}

	// ── Edits, slices, TODOs ───────────────────────────────────────────────

	private edit(start: number, end: number, text: string): void {
		if (this.isProtected(start)) return;
		this.leaf.push({ start, end, text });
	}

	/** Source text of `[start, end)` with the leaf edits inside it applied (and consumed). */
	private slice(start: number, end: number, extra: readonly Edit[] = []): string {
		const inner: Edit[] = [];
		for (const e of this.leaf) {
			if (e.consumed || e.start < start || e.end > end) continue;
			if (e.start === e.end && (e.start === start || e.start === end)) continue;
			inner.push({ start: e.start - start, end: e.end - start, text: e.text });
		}
		for (const [pos, anchor] of this.anchors) {
			if (anchor.consumed || pos <= start || pos >= end) continue;
			const t = this.renderAnchor(pos, anchor);
			if (t) inner.push({ start: pos - start, end: pos - start, text: t });
		}
		for (const e of extra) inner.push({ start: e.start - start, end: e.end - start, text: e.text });
		return applyEdits(this.text.slice(start, end), inner);
	}

	/** Mark edits and anchors inside `[start, end)` consumed (they are now part of a job's output). */
	private consumeWithin(start: number, end: number, excludeLast: boolean): void {
		const last = excludeLast ? this.leaf[this.leaf.length - 1] : undefined;
		for (const e of this.leaf) {
			if (e === last || e.consumed) continue;
			if (e.start >= start && e.end <= end && !(e.start === e.end && (e.start === start || e.start === end))) {
				e.consumed = true;
			}
		}
		for (const [pos, anchor] of this.anchors) if (pos > start && pos < end) anchor.consumed = true;
	}

	/** Leave a TODO above the statement containing `node`. */
	private todo(node: TS.Node, todo: Todo): void {
		const anchor = this.anchorOf(node);
		const pos = lineStart(this.text, anchor.getStart(this.sf));
		const existing = this.anchors.get(pos);
		const key = todoKey(todo);
		if (existing) {
			if (!existing.todos.some((t) => todoKey(t) === key)) existing.todos.push(todo);
			return;
		}
		this.anchors.set(pos, { indent: indentAt(this.text, anchor.getStart(this.sf)), todos: [todo] });
	}

	private anchorOf(node: TS.Node): TS.Node {
		const { ts } = this;
		let n: TS.Node = node;
		while (n.parent && !ts.isSourceFile(n.parent)) {
			const p = n.parent;
			if (ts.isBlock(p) || ts.isModuleBlock(p) || ts.isCaseClause(p) || ts.isDefaultClause(p)) break;
			if (ts.isClassDeclaration(p) || ts.isClassExpression(p)) break;
			// An object-literal member that starts its own line (e.g. an ApiNamespace method).
			if (ts.isObjectLiteralExpression(p) && startsLine(this.text, n.getStart(this.sf)) && this.isMemberAnchor(n))
				break;
			n = p;
		}
		return n;
	}

	private isMemberAnchor(n: TS.Node): boolean {
		const { ts } = this;
		return ts.isMethodDeclaration(n) || (ts.isPropertyAssignment(n) && n.getText(this.sf).includes('\n'));
	}

	private renderAnchor(pos: number, anchor: { indent: string; todos: Todo[] }): string {
		const above = this.commentLinesAbove(pos);
		const fresh = anchor.todos.filter((t) => !above.includes(firstLine(t)));
		if (fresh.length === 0) return '';
		return fresh.map((t) => renderTodo(t, anchor.indent, this.nl)).join('');
	}

	/** The `//` comment lines directly above `pos` (a line start), trimmed. */
	private commentLinesAbove(pos: number): string {
		const lines: string[] = [];
		let end = pos - 1;
		while (end > 0) {
			const start = lineStart(this.text, end);
			const line = this.text.slice(start, end).trim();
			if (!line.startsWith('//')) break;
			lines.push(line);
			end = start - 1;
		}
		return lines.join('\n');
	}

	// ── Object rendering ───────────────────────────────────────────────────

	private layoutOf(obj: TS.ObjectLiteralExpression): Layout {
		const text = obj.getText(this.sf);
		const multiline = text.includes('\n');
		const first = obj.properties[0];
		const closing = this.closingIndent(obj);
		let unit = closing.includes('\t') || this.text.includes('\n\t') ? '\t' : '  ';
		if (multiline && first) {
			const indent = indentAt(this.text, first.getStart(this.sf));
			if (indent.startsWith(closing) && indent.length > closing.length) unit = indent.slice(closing.length);
		}
		return { multiline, unit, nl: this.nl };
	}

	private closingIndent(obj: TS.ObjectLiteralExpression): string {
		const endBrace = obj.getEnd() - 1;
		return startsLine(this.text, endBrace)
			? indentAt(this.text, endBrace)
			: indentAt(this.text, obj.getStart(this.sf));
	}

	private renderObject(
		entries: OutEntry[],
		closing: string,
		layout: Layout,
		hoisted: Todo[],
		closingComments: string[] = [],
	): string {
		const live = entries.filter(
			(e) => !(e.key === null && e.value.t === 'text' && e.value.text === '' && e.todos.length === 0),
		);
		if (!layout.multiline) {
			for (const e of live) collectTodos(e, hoisted);
			const parts = live
				.filter((e) => !(e.key === null && e.value.t === 'text' && e.value.text === ''))
				.map((e) => this.renderEntryInline(e));
			return parts.length === 0 ? '{}' : `{ ${parts.join(', ')} }`;
		}
		const indent = closing + layout.unit;
		const lines: string[] = [];
		for (const e of live) {
			for (const c of e.comments) lines.push(`${indent}${c}`);
			for (const t of e.todos)
				lines.push(renderTodo(t, indent, layout.nl).replace(new RegExp(`${escapeRegExp(layout.nl)}$`), ''));
			if (e.key === null && e.value.t === 'text' && e.value.text === '') continue;
			const value = this.renderValue(e.value, indent, layout, hoisted);
			const body = e.key === null ? value : `${e.key}: ${value}`;
			lines.push(`${indent}${body},${e.trailing ? ` ${e.trailing}` : ''}`);
		}
		for (const c of closingComments) lines.push(`${indent}${c}`);
		return `{${layout.nl}${lines.join(layout.nl)}${layout.nl}${closing}}`;
	}

	private renderValue(v: OutValue, indent: string, layout: Layout, hoisted: Todo[]): string {
		if (v.t === 'text') return v.indent ? reindent(v.text, v.indent, indent) : v.text;
		if (v.t === 'call') return `${v.callee}(${v.arg ? this.renderValue(v.arg, indent, layout, hoisted) : ''})`;
		if (v.inline) return this.renderInline(v.entries);
		return this.renderObject(v.entries, indent, layout, hoisted);
	}

	private renderInline(entries: OutEntry[]): string {
		return entries.length === 0 ? '{}' : `{ ${entries.map((e) => this.renderEntryInline(e)).join(', ')} }`;
	}

	private renderEntryInline(e: OutEntry): string {
		const v = e.value;
		const value =
			v.t === 'text'
				? v.text
				: v.t === 'call'
					? `${v.callee}(${v.arg ? (v.arg.t === 'obj' ? this.renderInline(v.arg.entries) : v.arg.t === 'text' ? v.arg.text : '') : ''})`
					: this.renderInline(v.entries);
		return e.key === null ? value : `${e.key}: ${value}`;
	}

	// ── Property helpers ───────────────────────────────────────────────────

	private propOf(obj: TS.ObjectLiteralExpression, name: string): TS.ObjectLiteralElementLike | undefined {
		return obj.properties.find((p) => propName(this.ts, p) === name);
	}

	private leadingComments(node: TS.Node): string[] {
		const ranges = this.ts.getLeadingCommentRanges(this.text, node.getFullStart()) ?? [];
		return ranges.map((r) => this.text.slice(r.pos, r.end));
	}

	/**
	 * Per property: comments on their own lines before it, and a same-line
	 * comment after it; plus the comments between the last property and `}`.
	 */
	private propertyComments(obj: TS.ObjectLiteralExpression): {
		props: { leading: string[]; trailing: string | undefined }[];
		closing: string[];
	} {
		const props = obj.properties;
		const out = props.map(() => ({ leading: [] as string[], trailing: undefined as string | undefined }));
		const closing: string[] = [];
		const assign = (
			ranges: readonly TS.CommentRange[],
			prevEnd: number | undefined,
			prevIndex: number,
			nextIndex: number | undefined,
		): void => {
			for (const r of ranges) {
				const c = this.text.slice(r.pos, r.end);
				const sameLineAsPrev = prevEnd !== undefined && !this.text.slice(prevEnd, r.pos).includes('\n');
				const slot = out[prevIndex];
				if (sameLineAsPrev && slot && slot.trailing === undefined) slot.trailing = c;
				else if (nextIndex === undefined) closing.push(c);
				else out[nextIndex]?.leading.push(c);
			}
		};
		// Same-line comments after a property's comma are TypeScript "trailing"
		// comments of that position; later lines are "leading" ones.
		const around = (pos: number): TS.CommentRange[] => [
			...(this.ts.getTrailingCommentRanges(this.text, pos) ?? []),
			...(this.ts.getLeadingCommentRanges(this.text, pos) ?? []),
		];
		props.forEach((prop, i) => {
			const prev = props[i - 1];
			const ranges =
				i === 0
					? (this.ts.getLeadingCommentRanges(this.text, prop.getFullStart()) ?? [])
					: around(prop.getFullStart());
			assign(ranges, prev?.getEnd(), i - 1, i);
		});
		const last = props[props.length - 1];
		if (last) {
			const comma = props.hasTrailingComma ? this.text.indexOf(',', last.getEnd()) + 1 : last.getEnd();
			assign(around(comma), last.getEnd(), props.length - 1, undefined);
		}
		return { props: out, closing };
	}
}

// ─── Option tables ─────────────────────────────────────────────────────────

/** Old option → new path (last element is the new key). Combined options are handled in code. */
const SIMPLE_OPTIONS: Readonly<Record<OldBlock, Readonly<Record<string, readonly string[]>>>> = {
	cognito: {
		admin: ['admin'],
		authFlowType: ['users', 'authFlow'],
		codeDelivery: ['codeDelivery'],
		crossDomain: ['session', 'crossDomain'],
		deviceTracking: ['users', 'deviceTracking'],
		featurePlan: ['featurePlan'],
		groups: ['users', 'groups'],
		logger: ['logger'],
		passwordPolicy: ['emailPassword', 'passwordPolicy'],
		preferredChallenge: ['users', 'preferredChallenge'],
		removalPolicy: ['removalPolicy'],
		selfSignUp: ['emailPassword', 'selfSignUp'],
		sessionTtlSeconds: ['session', 'ttlSeconds'],
		userAttributes: ['users', 'attributes'],
		userPool: ['userPool'],
	},
	basic: {
		codeDelivery: ['codeDelivery'],
		crossDomain: ['session', 'crossDomain'],
		logger: ['logger'],
		passwordPolicy: ['emailPassword', 'passwordPolicy'],
		sessionDuration: ['session', 'ttlSeconds'],
	},
	oidc: {
		allowBearerAuth: ['allowBearerAuth'],
		allowedRelayOrigins: ['redirects', 'allowedRelayOrigins'],
		callbackPath: ['redirects', 'callbackPath'],
		crossDomain: ['session', 'crossDomain'],
		logger: ['logger'],
		onSignIn: ['onSignIn'],
		onSignOut: ['onSignOut'],
		postSignInPath: ['redirects', 'postSignInPath'],
		signOutPath: ['redirects', 'signOutPath'],
	},
};

// ─── Small helpers ─────────────────────────────────────────────────────────

function propName(ts: TypeScript, p: TS.ObjectLiteralElementLike): string | undefined {
	if (ts.isSpreadAssignment(p)) return undefined;
	const name = p.name;
	if (!name) return undefined;
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	return undefined;
}

function valueNode(ts: TypeScript, p: TS.ObjectLiteralElementLike | undefined): TS.Expression | undefined {
	if (!p) return undefined;
	if (ts.isPropertyAssignment(p)) return p.initializer;
	return undefined;
}

/** The string value of a (possibly `as const`) string literal. */
function literalOf(ts: TypeScript, n: TS.Expression | undefined): string | undefined {
	if (!n) return undefined;
	const e = unwrap(ts, n);
	if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
	return undefined;
}

function unwrapKind(ts: TypeScript, n: TS.Expression | undefined): TS.SyntaxKind | undefined {
	return n ? unwrap(ts, n).kind : undefined;
}

/** `() => x.get()`, `async () => await x.get()`, `() => { return x.get(); }` → `x`. */
function getterTarget(ts: TypeScript, n: TS.Expression): TS.Expression | undefined {
	const fn = unwrap(ts, n);
	if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || fn.parameters.length > 0) return undefined;
	let body: TS.Node = fn.body;
	if (ts.isBlock(body)) {
		const only = body.statements.length === 1 ? body.statements[0] : undefined;
		if (!only || !ts.isReturnStatement(only) || !only.expression) return undefined;
		body = only.expression;
	}
	let expr = body as TS.Expression;
	if (ts.isParenthesizedExpression(expr)) expr = expr.expression;
	if (ts.isAwaitExpression(expr)) expr = expr.expression;
	if (!ts.isCallExpression(expr) || expr.arguments.length > 0) return undefined;
	const callee = expr.expression;
	if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'get') return undefined;
	return callee.expression;
}

function keyOf(name: string, quote: string): string {
	return IDENT_RE.test(name)
		? name
		: `${quote}${name.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`)}${quote}`;
}

function detectQuote(ts: TypeScript, sf: TS.SourceFile): string {
	for (const stmt of sf.statements) {
		if (ts.isImportDeclaration(stmt)) return stmt.moduleSpecifier.getText(sf).startsWith('"') ? '"' : "'";
	}
	return "'";
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function collectTodos(e: OutEntry, into: Todo[]): void {
	into.push(...e.todos);
	if (e.value.t === 'obj') for (const c of e.value.entries) collectTodos(c, into);
	if (e.value.t === 'call' && e.value.arg?.t === 'obj') for (const c of e.value.arg.entries) collectTodos(c, into);
}

function countTodos(text: string): number {
	return text.split(`// ${TODO_TAG}:`).length - 1;
}

function firstLine(t: Todo): string {
	return `// ${TODO_TAG}: ${typeof t === 'string' ? t : (t[0] ?? '')}`;
}

function todoKey(t: Todo): string {
	return typeof t === 'string' ? t : t.join('\n');
}

function renderTodo(t: Todo, indent: string, nl: string): string {
	const lines = typeof t === 'string' ? [t] : t;
	return lines.map((l, i) => (i === 0 ? `${indent}// ${TODO_TAG}: ${l}${nl}` : `${indent}//   ${l}${nl}`)).join('');
}

// ─── The id guard ──────────────────────────────────────────────────────────

/**
 * Re-parse `after` and check that every constructor call of an old auth block
 * in `before` kept its first two arguments (scope and id) byte for byte. The
 * codemod never adds or removes a `new` expression, so the two lists line up.
 *
 * @throws {IdPreservationError} when an argument changed — nothing is written.
 */
export function assertIdsPreserved(ts: TypeScript, fileName: string, before: string, after: string): void {
	const collect = (text: string, onlyOld: boolean): { callee: string; args: string[] }[] => {
		const sf = parse(ts, fileName, text);
		const classes = onlyOld ? oldClassLocals(ts, sf) : undefined;
		const out: { callee: string; args: string[] }[] = [];
		const visit = (n: TS.Node): void => {
			if (ts.isNewExpression(n)) {
				const callee = n.expression.getText(sf);
				const isOld = classes
					? classes.has(callee) ||
						OLD_CLASS_NAMES.has(callee) ||
						(ts.isPropertyAccessExpression(n.expression) && OLD_CLASS_NAMES.has(n.expression.name.text))
					: true;
				out.push({
					callee: isOld ? 'old' : callee,
					args: (n.arguments ?? []).slice(0, 2).map((a) => a.getText(sf)),
				});
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
		return out;
	};
	const was = collect(before, true);
	const now = collect(after, false);
	if (was.length !== now.length) {
		throw new IdPreservationError(
			`${fileName}: the number of constructor calls changed (${was.length} → ${now.length}).`,
		);
	}
	was.forEach((w, i) => {
		if (w.callee !== 'old') return;
		const n = now[i];
		if (!n || n.args.length !== w.args.length || n.args.some((a, k) => a !== w.args[k])) {
			throw new IdPreservationError(
				`${fileName}: the scope/id arguments of an auth block changed (${JSON.stringify(w.args)} → ${JSON.stringify(n?.args)}). Refusing to write: a changed id replaces the user pool.`,
			);
		}
	});
}
