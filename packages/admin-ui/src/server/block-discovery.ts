// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Dirent } from 'node:fs';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import ts from 'typescript';
import type {
	ApiMethod,
	ApiMethodParam,
	BlockKeySchema,
	BlocksResponse,
	BlockSettingDeclaration,
	DiscoveredBlock,
	ScopeInfo,
	SettingNameSource,
	UnknownConstruct,
} from '../contract/v1.js';
import { BLOCK_CATALOG } from './block-catalog.generated.js';

/**
 * Block inventory read out of the user's own `aws-blocks/**\/*.ts` sources.
 *
 * DECLARATION SIDE ONLY. Everything here comes from the AST, so it describes
 * what the app *declares*; it never claims anything about what is deployed.
 * That is why `resourceGroupIds` is left undefined — a later stage joins
 * discovery against live resources, and discovery filling that field in would
 * imply a deployment it has not looked at.
 *
 * ## Why binding resolution instead of matching the callee's text
 *
 * The obvious implementation compares `newExpr.expression.getText()` against a
 * list of known block names. That is wrong in three directions at once, and all
 * three occur in real projects:
 *
 * 1. `import * as blocks from '@aws-blocks/blocks'; new blocks.KVStore(...)` —
 *    the callee text is `blocks.KVStore`, which is in no name list, so a real
 *    block is silently missing from the dashboard.
 * 2. `import { KVStore as Store } from '@aws-blocks/bb-kv-store'; new Store(...)` —
 *    the callee text is `Store`, so an aliased block disappears the same way.
 * 3. `class KVStore {}` declared locally and instantiated — the callee text is
 *    `KVStore`, so a user's own unrelated class is reported as an AWS block,
 *    inventing a resource that does not exist.
 *
 * So we resolve the identifier back to the import it came from: collect the
 * file's import bindings, then accept a `new X(...)` only when `X`'s binding
 * resolves to an `@aws-blocks/*` module, and look the catalog up by the
 * module's EXPORTED name rather than the local alias. A `new X(...)` with no
 * such binding is skipped without comment — `new Date()` or `new MyThing()` is
 * not a gap worth reporting to the user.
 *
 * ## Nothing block-shaped is dropped silently
 *
 * A construct that clearly is a block declaration but that we cannot turn into
 * a `DiscoveredBlock` goes to `unknownConstructs` with a reason: an
 * `@aws-blocks/*` class the catalog has never heard of (`'unknown-type'`), or a
 * known block whose id argument is not a string literal (`'non-literal-id'`).
 * Both are visible gaps rather than absences.
 *
 * Parsing is parse-only: `ts.createSourceFile` per file, no program and no type
 * checker, so a project that does not currently compile still scans, and a
 * single unparseable file costs only that file.
 */

/** Files parsed per scan unless the caller raises it. Guards a pathological tree. */
export const DEFAULT_MAX_FILES = 200;

/** Longest `configPreview` we keep; previews are for orientation, not for reading. */
export const CONFIG_PREVIEW_LIMIT = 800;

/** Appended to a `configPreview` that hit `CONFIG_PREVIEW_LIMIT`. */
export const CONFIG_PREVIEW_TRUNCATION_MARKER = '… (truncated)';

/** Every block class is exported from a package under this scope. */
const AWS_BLOCKS_MODULE_PREFIX = '@aws-blocks/';

/** Not a block: the construct that owns them, and the source of `fullId`. */
const SCOPE_CLASS = 'Scope';

/** The one block whose methods we read out of the source. */
const API_NAMESPACE_CLASS = 'ApiNamespace';

/** The one block carrying an editable value, so the one whose options we read. */
const APP_SETTING_CLASS = 'AppSetting';

/** The static factory that declares a block owned outside the stack. */
const FROM_EXISTING_METHOD = 'fromExisting';

/**
 * Directory names never scanned. `scripts/` holds sandbox and dev-server
 * entry points, which construct nothing the dashboard should list.
 */
const EXCLUDED_DIR_NAMES = new Set(['scripts', 'node_modules']);

/**
 * Generated entry points, excluded wherever they appear: `index.cdk.ts` is the
 * CDK synth shim and `index.handler.ts` the Lambda shim, and both re-reference
 * blocks declared elsewhere. Counting them would double every block.
 */
const EXCLUDED_FILE_NAMES = new Set(['index.cdk.ts', 'index.handler.ts']);

/** `BlocksResponse` minus the envelope field the route adds. */
export type BlocksResult = Omit<BlocksResponse, 'apiVersion'>;

export interface DiscoverBlocksOptions {
	/** App root — the directory that contains `aws-blocks/`. */
	projectRoot: string;
	/** Cap on files parsed. Default {@link DEFAULT_MAX_FILES}. */
	maxFiles?: number;
}

/**
 * One import binding, keyed elsewhere by its LOCAL name.
 *
 * `importedName` is the name the module exports, which is what the catalog is
 * keyed by; for `import { KVStore as Store }` the local name is `Store` and
 * `importedName` is `KVStore`. A namespace import binds a whole module and so
 * has no single imported name — the member access supplies it instead.
 */
interface ImportBinding {
	moduleSpecifier: string;
	importedName?: string;
	kind: 'named' | 'default' | 'namespace';
}

/** A `new X(...)` callee resolved through the file's imports. */
interface ResolvedClass {
	/** Callee exactly as written, e.g. `blocks.KVStore` — for `UnknownConstruct.text`. */
	text: string;
	/** Name the module exports, e.g. `KVStore`. The catalog key. */
	importedName: string;
}

/** A block found in one file, before `fullId` (which needs the whole-project scope). */
interface RawBlock {
	block: Omit<DiscoveredBlock, 'fullId'>;
}

interface ScanState {
	raw: RawBlock[];
	unknown: UnknownConstruct[];
	scope?: ScopeInfo;
	fileErrors: string[];
	scannedFiles: number;
}

function isAwsBlocksModule(moduleSpecifier: string): boolean {
	return moduleSpecifier.startsWith(AWS_BLOCKS_MODULE_PREFIX);
}

/** Always POSIX separators, so a path is stable across platforms. */
function toRelativePosix(projectRoot: string, absolutePath: string): string {
	return relative(projectRoot, absolutePath).split(sep).join('/');
}

/**
 * Local name → binding, for one file.
 *
 * Type-only imports and type-only specifiers are skipped: a type cannot be
 * instantiated, so a `new X(...)` whose only binding is `import type { X }` is
 * not a block declaration but a compile error in the user's project.
 */
function collectImportBindings(sourceFile: ts.SourceFile): Map<string, ImportBinding> {
	const bindings = new Map<string, ImportBinding>();
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const clause = statement.importClause;
		if (!clause || clause.isTypeOnly) continue;
		const moduleSpecifier = statement.moduleSpecifier.text;
		if (clause.name) {
			// `import KVStore from '...'` — no exported name to read, so the
			// local name is the best available type name.
			bindings.set(clause.name.text, {
				moduleSpecifier,
				importedName: clause.name.text,
				kind: 'default',
			});
		}
		const named = clause.namedBindings;
		if (named && ts.isNamespaceImport(named)) {
			bindings.set(named.name.text, { moduleSpecifier, kind: 'namespace' });
		} else if (named && ts.isNamedImports(named)) {
			for (const element of named.elements) {
				if (element.isTypeOnly) continue;
				bindings.set(element.name.text, {
					moduleSpecifier,
					importedName: (element.propertyName ?? element.name).text,
					kind: 'named',
				});
			}
		}
	}
	return bindings;
}

/**
 * Resolve a `new X(...)` / `new ns.X(...)` callee to the `@aws-blocks/*` class
 * it names, or `undefined` when it does not name one.
 *
 * `undefined` covers the case that matters most: an identifier with no import
 * binding at all is the user's own declaration (see the module comment's third
 * defect), so it is not a block no matter what it is called.
 */
function resolveBlockClass(
	expression: ts.Expression,
	bindings: ReadonlyMap<string, ImportBinding>,
): ResolvedClass | undefined {
	if (ts.isIdentifier(expression)) {
		const binding = bindings.get(expression.text);
		if (!binding || binding.kind === 'namespace' || !binding.importedName) return undefined;
		if (!isAwsBlocksModule(binding.moduleSpecifier)) return undefined;
		return { text: expression.text, importedName: binding.importedName };
	}
	if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
		const binding = bindings.get(expression.expression.text);
		if (binding?.kind !== 'namespace') return undefined;
		if (!isAwsBlocksModule(binding.moduleSpecifier)) return undefined;
		return {
			text: `${expression.expression.text}.${expression.name.text}`,
			importedName: expression.name.text,
		};
	}
	return undefined;
}

/** 1-based line of a node, which is what an editor and a stack trace both show. */
function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
	return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * Whether the call is shaped like a block declaration: `new X(scope, 'id', ...)`.
 *
 * Used only for an unrecognised `@aws-blocks/*` class, to tell a block we have
 * not heard of from the other things those packages export (clients, errors,
 * helpers). Without the shape test, every `new DatabaseErrors(...)` would be
 * reported as a missing block.
 */
function looksLikeBlockCall(args: readonly ts.Expression[]): boolean {
	const scopeArg = args[0];
	if (!scopeArg || args.length < 2) return false;
	return ts.isIdentifier(scopeArg) || ts.isPropertyAccessExpression(scopeArg);
}

function unwrapParens(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (ts.isParenthesizedExpression(current)) current = current.expression;
	return current;
}

function propertyNamed(literal: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
	for (const property of literal.properties) {
		if (!ts.isPropertyAssignment(property)) continue;
		const propertyName = property.name;
		const text = ts.isIdentifier(propertyName)
			? propertyName.text
			: ts.isStringLiteral(propertyName)
				? propertyName.text
				: undefined;
		if (text === name) return property;
	}
	return undefined;
}

function stringLiteralValue(expression: ts.Expression | undefined): string | undefined {
	// Deliberately `isStringLiteral` only: a no-substitution template literal
	// reads like a constant but is a different node, and the spec treats every
	// non-string-literal id as unnameable rather than guessing at its value.
	if (expression && ts.isStringLiteral(expression)) return expression.text;
	return undefined;
}

/**
 * `{ key: { partitionKey: 'pk', sortKey: 'sk' } }` off a config literal.
 *
 * All-or-nothing: a `sortKey` built from a variable makes the whole schema
 * unreportable rather than a partial one, because a key schema that is right
 * about the partition and silent about the sort is indistinguishable from a
 * table that has no sort key.
 */
function extractKeySchema(config: ts.ObjectLiteralExpression): BlockKeySchema | undefined {
	const keyProperty = propertyNamed(config, 'key');
	if (!keyProperty || !ts.isObjectLiteralExpression(keyProperty.initializer)) return undefined;
	const keyLiteral = keyProperty.initializer;
	const partitionProperty = propertyNamed(keyLiteral, 'partitionKey');
	if (!partitionProperty) return undefined;
	const partitionKey = stringLiteralValue(partitionProperty.initializer);
	if (partitionKey === undefined) return undefined;
	const sortProperty = propertyNamed(keyLiteral, 'sortKey');
	if (!sortProperty) return { partitionKey };
	const sortKey = stringLiteralValue(sortProperty.initializer);
	if (sortKey === undefined) return undefined;
	return { partitionKey, sortKey };
}

/**
 * The object literal that actually carries an ApiNamespace's methods.
 *
 * Real apps write `new ApiNamespace(scope, 'api', (ctx) => ({ ...methods }))`,
 * so the literal is the arrow's concise body — but a factory may declare locals
 * first and return the methods at the end. Taking the FIRST object literal
 * anywhere beneath the argument (the obvious approach) picks up whichever local
 * `{ ... }` came first and reports its keys as API methods, which is worse than
 * reporting none.
 *
 * So: the concise body, or the ONE object literal the block body returns.
 * `returnsOwnedBy` looks inside `if`/`try`/`switch` — a guard-clause return is a
 * real second answer — but stops at nested function boundaries, because a
 * method's own `return { ok: true }` is not a candidate handler surface. Two
 * competing returns mean the API surface is conditional and we cannot name it
 * from the AST, so we emit no methods rather than half of them.
 */
function resolveMethodsLiteral(argument: ts.Expression): ts.ObjectLiteralExpression | undefined {
	const unwrapped = unwrapParens(argument);
	if (ts.isObjectLiteralExpression(unwrapped)) return unwrapped;
	if (!ts.isArrowFunction(unwrapped) && !ts.isFunctionExpression(unwrapped)) return undefined;
	const body = unwrapped.body;
	if (!ts.isBlock(body)) {
		const concise = unwrapParens(body);
		return ts.isObjectLiteralExpression(concise) ? concise : undefined;
	}
	const returned: ts.ObjectLiteralExpression[] = [];
	for (const statement of returnsOwnedBy(body)) {
		if (!statement.expression) continue;
		const value = unwrapParens(statement.expression);
		if (ts.isObjectLiteralExpression(value)) returned.push(value);
	}
	return returned.length === 1 ? returned[0] : undefined;
}

/** Return statements in this function's own scope, not in functions nested in it. */
function returnsOwnedBy(body: ts.Block): ts.ReturnStatement[] {
	const found: ts.ReturnStatement[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
		if (ts.isReturnStatement(node)) found.push(node);
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(body, visit);
	return found;
}

/** Parameter NAMES only; types come from the generated spec in a later stage. */
function extractParams(parameters: readonly ts.ParameterDeclaration[]): ApiMethodParam[] {
	return parameters.map((parameter) => {
		// A destructured parameter has no name, so its source text is the most
		// honest thing to show; it is never invented.
		const name = ts.isIdentifier(parameter.name) ? parameter.name.text : parameter.name.getText();
		const optional = parameter.questionToken !== undefined || parameter.initializer !== undefined;
		return optional ? { name, optional: true } : { name };
	});
}

/**
 * Method names and parameter names off the methods literal.
 *
 * Covers both forms users write: a method declaration (`getPage(slug) {}`) and
 * a property holding an arrow or function expression. A spread contributes
 * methods we cannot see, so the list can be incomplete — but every entry in it
 * is one the source really declares.
 */
function extractApiMethods(literal: ts.ObjectLiteralExpression): ApiMethod[] {
	const methods: ApiMethod[] = [];
	for (const property of literal.properties) {
		const name = property.name;
		const methodName = name
			? ts.isIdentifier(name)
				? name.text
				: ts.isStringLiteral(name)
					? name.text
					: undefined
			: undefined;
		if (methodName === undefined) continue;
		if (ts.isMethodDeclaration(property)) {
			methods.push({ name: methodName, params: extractParams(property.parameters) });
			continue;
		}
		if (ts.isPropertyAssignment(property)) {
			const initializer = unwrapParens(property.initializer);
			if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
				methods.push({ name: methodName, params: extractParams(initializer.parameters) });
			}
		}
	}
	return methods;
}

function buildConfigPreview(config: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile): string {
	const text = config.getText(sourceFile);
	if (text.length <= CONFIG_PREVIEW_LIMIT) return text;
	return `${text.slice(0, CONFIG_PREVIEW_LIMIT)}${CONFIG_PREVIEW_TRUNCATION_MARKER}`;
}

/**
 * Whether an AppSetting declares `secret: true`, failing CLOSED.
 *
 * A `secret` property whose initializer is not a boolean literal (`secret:
 * isProd`) cannot be decided from source, and the two wrong answers are not
 * symmetric: calling a secret non-secret puts its value on screen, while
 * calling a plain value secret only masks something harmless. So anything
 * except a literal `false` counts as a secret here.
 */
function declaresSecret(config: ts.ObjectLiteralExpression): boolean {
	const property = propertyNamed(config, 'secret');
	if (!property) return false;
	return property.initializer.kind !== ts.SyntaxKind.FalseKeyword;
}

/**
 * `{ name, secret, schema }` off an AppSetting config literal.
 *
 * Deliberately NOT all-or-nothing, unlike {@link extractKeySchema}: those two
 * key fields describe one indivisible thing, while these three are independent
 * facts, and `secret` is the one a reader must never lose. An explicit `name`
 * built from a variable therefore yields `nameSource: 'unresolved'` while
 * `secret` still reports what the source says.
 *
 * `parameterName` is left for the caller to derive when the declaration does
 * not name one, because the default (`/${fullId}`) needs the project scope,
 * which a single file does not know.
 */
function extractSettingDeclaration(
	config: ts.ObjectLiteralExpression | undefined,
	external: boolean,
): BlockSettingDeclaration {
	const nameProperty = config ? propertyNamed(config, 'name') : undefined;
	const explicitName = nameProperty ? stringLiteralValue(nameProperty.initializer) : undefined;
	let nameSource: SettingNameSource = 'derived';
	if (nameProperty) nameSource = explicitName === undefined ? 'unresolved' : 'explicit';
	const declaration: BlockSettingDeclaration = {
		nameSource,
		secret: config ? declaresSecret(config) : false,
		hasSchema: config ? propertyNamed(config, 'schema') !== undefined : false,
		external,
	};
	if (explicitName !== undefined) declaration.parameterName = explicitName;
	return declaration;
}

/** Depth-first `**\/*.ts` walk, excluding declarations, shims and `scripts/`. */
function collectSourceFiles(blocksDir: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			// An unreadable directory is not a reason to abandon the scan.
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (EXCLUDED_DIR_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
				walk(full);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!entry.name.endsWith('.ts')) continue;
			if (entry.name.endsWith('.d.ts')) continue;
			if (EXCLUDED_FILE_NAMES.has(entry.name)) continue;
			found.push(full);
		}
	};
	walk(blocksDir);
	// Sorted so both the file order and the scope chosen below are deterministic.
	return found.sort();
}

/**
 * Syntax errors the parser recovered from.
 *
 * `parseDiagnostics` is internal to the compiler, so it is read defensively:
 * when a future TypeScript drops it we lose the PARSE_FAILED signal, never the
 * scan itself.
 */
function parseErrorOf(sourceFile: ts.SourceFile): string | undefined {
	const diagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
	const first = diagnostics?.[0];
	if (!first) return undefined;
	return ts.flattenDiagnosticMessageText(first.messageText, ' ');
}

function scanFile(absolutePath: string, relativePath: string, state: ScanState): void {
	let text: string;
	try {
		text = readFileSync(absolutePath, 'utf8');
	} catch (error) {
		state.fileErrors.push(`${relativePath} (${(error as Error).message})`);
		return;
	}
	state.scannedFiles += 1;
	const sourceFile = ts.createSourceFile(absolutePath, text, ts.ScriptTarget.Latest, true);
	const parseError = parseErrorOf(sourceFile);
	if (parseError) state.fileErrors.push(`${relativePath} (${parseError})`);
	const bindings = collectImportBindings(sourceFile);

	/**
	 * Record one block declaration, shared by `new X(...)` and by
	 * `AppSetting.fromExisting(...)` because both carry the same
	 * `(scope, 'id', options)` arguments.
	 */
	const pushBlock = (
		resolved: ResolvedClass,
		args: readonly ts.Expression[],
		line: number,
		external: boolean,
	): void => {
		const entry = BLOCK_CATALOG.get(resolved.importedName);
		if (!entry) {
			// An `@aws-blocks/*` class the catalog does not know. Reported, not
			// dropped: a third-party or newly added block must show up as a gap.
			if (looksLikeBlockCall(args)) {
				state.unknown.push({
					text: resolved.text,
					file: relativePath,
					line,
					reason: 'unknown-type',
				});
			}
			return;
		}

		const id = stringLiteralValue(args[1]);
		if (id === undefined) {
			// A known block we cannot name — a variable, a template literal, or
			// a factory loop. Surfaced rather than silently omitted.
			state.unknown.push({
				text: resolved.text,
				file: relativePath,
				line,
				reason: 'non-literal-id',
			});
			return;
		}

		const block: Omit<DiscoveredBlock, 'fullId'> = {
			type: resolved.importedName,
			id,
			category: entry.category,
			file: relativePath,
			line,
		};
		// Set only when the catalog has one: an absent description is a normal
		// state (a multi-class package), so an empty string would turn "nothing
		// to say" into "says nothing", which renders as a blank line.
		if (entry.description) block.description = entry.description;
		const thirdArg = args[2] ? unwrapParens(args[2]) : undefined;
		const config = thirdArg && ts.isObjectLiteralExpression(thirdArg) ? thirdArg : undefined;
		if (config) {
			block.configPreview = buildConfigPreview(config, sourceFile);
			const keySchema = extractKeySchema(config);
			// Only table-backed blocks carry a `key` config, so its presence is
			// the test — no second hard-coded list of which blocks have tables.
			if (keySchema) block.keySchema = keySchema;
		}
		// Unconditional for an AppSetting, including one written with no options
		// at all: `secret` and `hasSchema` both defaulting to false IS the
		// declaration, and omitting the field would read as "not a setting".
		if (resolved.importedName === APP_SETTING_CLASS) {
			block.setting = extractSettingDeclaration(config, external);
		}
		if (resolved.importedName === API_NAMESPACE_CLASS && args[2]) {
			const literal = resolveMethodsLiteral(args[2]);
			if (literal) block.methods = extractApiMethods(literal);
		}
		state.raw.push({ block });
	};

	const inspect = (node: ts.NewExpression): void => {
		const resolved = resolveBlockClass(node.expression, bindings);
		// No `@aws-blocks/*` binding: the user's own class, or a third-party
		// one. Not a block, and not a gap — skip without reporting.
		if (!resolved) return;
		const line = lineOf(sourceFile, node);
		const args = node.arguments ?? [];

		if (resolved.importedName === SCOPE_CLASS) {
			// Several `new Scope(...)` in one project is user error we cannot
			// resolve; the first in sorted-file order wins so the answer is at
			// least stable between runs. A non-literal scope id yields no scope
			// at all, which degrades every `fullId` (see buildResult).
			const scopeId = stringLiteralValue(args[0]);
			if (scopeId !== undefined && !state.scope) {
				state.scope = { id: scopeId, file: relativePath, line };
			}
			return;
		}

		pushBlock(resolved, args, line, false);
	};

	/**
	 * `AppSetting.fromExisting(scope, 'id', { name })`: a block declaration that
	 * is not a `new` expression, and so was invisible to this scan.
	 *
	 * Scoped to AppSetting deliberately, not generalised to every
	 * `fromExisting`. Other blocks expose one with a different shape:
	 * `AuthCognito.fromExisting(userPoolId, clientId)` carries neither a scope
	 * nor an id, so it cannot produce a `DiscoveredBlock` at all. AppSetting's
	 * overload is the one that takes the same `(scope, 'id', options)` arguments
	 * as the constructor, which is what lets it share `pushBlock`.
	 */
	const inspectStaticFactory = (node: ts.CallExpression): void => {
		const callee = node.expression;
		if (!ts.isPropertyAccessExpression(callee)) return;
		if (callee.name.text !== FROM_EXISTING_METHOD) return;
		const resolved = resolveBlockClass(callee.expression, bindings);
		if (!resolved || resolved.importedName !== APP_SETTING_CLASS) return;
		pushBlock(resolved, node.arguments, lineOf(sourceFile, node), true);
	};

	const visit = (node: ts.Node): void => {
		if (ts.isNewExpression(node)) inspect(node);
		else if (ts.isCallExpression(node)) inspectStaticFactory(node);
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
}

function readPackageName(projectRoot: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
			name?: unknown;
		};
		return typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : undefined;
	} catch {
		return undefined;
	}
}

function unavailable(projectRoot: string, message: string, code: 'NOT_A_BLOCKS_PROJECT' | 'UNKNOWN'): BlocksResult {
	return {
		blocksSource: 'unavailable',
		blocksError: message,
		blocksErrorCode: code,
		projectName: readPackageName(projectRoot) ?? basename(projectRoot),
		blocks: [],
		unknownConstructs: [],
		scannedFiles: 0,
	};
}

/**
 * Blocks the app declares under `<projectRoot>/aws-blocks/`.
 *
 * Never throws — not for a missing directory, not for an unparseable file, not
 * for an unreadable one. This feeds a dashboard whose job includes explaining a
 * broken project, so a rejection here would take out the very view meant to
 * describe the breakage. Failures come back as `blocksErrorCode` plus an
 * actionable `blocksError`, alongside whatever was found.
 */
export function discoverBlocks(options: DiscoverBlocksOptions): BlocksResult {
	const { projectRoot } = options;
	const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
	try {
		const blocksDir = join(projectRoot, 'aws-blocks');
		if (!existsSync(blocksDir) || !statSync(blocksDir).isDirectory()) {
			return unavailable(
				projectRoot,
				`No aws-blocks/ directory in ${projectRoot}. Run the dashboard from the root of a Blocks app (the directory containing aws-blocks/), or create aws-blocks/index.ts to declare your first block.`,
				'NOT_A_BLOCKS_PROJECT',
			);
		}

		const allFiles = collectSourceFiles(blocksDir);
		const files = maxFiles >= 0 ? allFiles.slice(0, maxFiles) : [];
		const state: ScanState = { raw: [], unknown: [], fileErrors: [], scannedFiles: 0 };
		for (const file of files) {
			scanFile(file, toRelativePosix(projectRoot, file), state);
		}

		// `fullId` is how physical resources are named, so it needs the scope —
		// which may be declared in a file scanned after the blocks that use it.
		// Hence the two passes. With no scope found at all, every `fullId`
		// degrades to the bare `id`, and the join later stages do against
		// deployed resource names will not match: that is why a project with no
		// resolvable `new Scope('id')` is worth noticing in the output.
		const scopeId = state.scope?.id;
		// Duplicate `fullId`s are a real user error. They are emitted BOTH
		// times rather than deduped, so the collision is visible in the UI
		// instead of one declaration quietly disappearing.
		const blocks: DiscoveredBlock[] = state.raw.map(({ block }) => {
			const fullId = scopeId ? `${scopeId}-${block.id}` : block.id;
			const withId: DiscoveredBlock = { ...block, fullId };
			// The framework's default parameter path is `/${fullId}`, which only
			// this pass can build. Filled here rather than in the file scan for
			// the same reason `fullId` is: the scope may be declared in a file
			// scanned later. A declaration that named its own parameter keeps
			// that name, and an unresolvable one stays unaddressed.
			if (withId.setting?.nameSource === 'derived') {
				withId.setting = { ...withId.setting, parameterName: `/${fullId}` };
			}
			return withId;
		});

		const result: BlocksResult = {
			blocksSource: 'source-scan',
			projectName: scopeId ?? readPackageName(projectRoot) ?? basename(projectRoot),
			blocks,
			unknownConstructs: state.unknown,
			scannedFiles: state.scannedFiles,
		};
		if (state.scope) result.scope = state.scope;
		if (state.fileErrors.length > 0) {
			result.blocksErrorCode = 'PARSE_FAILED';
			result.blocksError = `Could not read ${state.fileErrors.length} of ${files.length} file(s) under aws-blocks/: ${state.fileErrors.join('; ')}. Blocks declared in those files are missing from this list — fix the syntax error and reload.`;
		}
		if (allFiles.length > files.length) {
			const capNote = `Stopped after ${files.length} of ${allFiles.length} file(s) under aws-blocks/ (maxFiles=${maxFiles}); blocks declared later are missing from this list.`;
			result.blocksError = result.blocksError ? `${result.blocksError} ${capNote}` : capNote;
			result.blocksErrorCode = result.blocksErrorCode ?? 'UNKNOWN';
		}
		return result;
	} catch (error) {
		return unavailable(
			projectRoot,
			`Unexpected error scanning aws-blocks/ in ${projectRoot}: ${(error as Error).message}`,
			'UNKNOWN',
		);
	}
}
