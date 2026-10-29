// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Extract TypeScript type information from ApiNamespace method signatures.
 *
 * Uses `ts.createProgram` with a full type checker to extract both explicit
 * and inferred types — including return types that have no annotation.
 * Converts TS types to JSON Schema for the OpenRPC spec.
 *
 * Zod-validated methods still take priority in generate-spec.ts — this
 * module provides the fallback for plain TS methods so they emit real
 * types instead of { type: "unknown" }.
 */

import * as ts from 'typescript';
import { dirname, join, relative, resolve } from 'path';
import { existsSync } from 'fs';

/**
 * The handler argument of `new ApiNamespace(scope, name, handler, options?)`: the
 * first function expression after the scope, else the third argument. Not simply
 * the last argument — with the optional fourth `options` argument that would be
 * the options object, and the namespace's methods would be missed.
 */
function apiNamespaceHandlerArg(node: ts.NewExpression): ts.Expression | undefined {
	const args = node.arguments ?? [];
	return (
		args.find((arg, i) => i >= 1 && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) ??
		args[2] ??
		args[args.length - 1]
	);
}

// ── Public types ────────────────────────────────────────────────────────────

export interface TransferableInfo {
	/** The __blocks literal value, e.g. "realtime/channel" */
	blocksTag: string;
	/** JSON Schemas of the generic type arguments (e.g., [T] in RealtimeChannel<T>), empty array if non-generic */
	typeArgs: JsonSchema[];
}

export interface MethodTypeInfo {
	params: ParamTypeInfo[];
	returnType: JsonSchema;
	/** Present when the return type is a transferable type */
	transferable?: TransferableInfo;
	/**
	 * True when the method's JSDoc carries a `@blocksSkipCodegen` tag. Methods so
	 * marked are still callable through the TS client (the runtime Proxy in
	 * `generate-client.ts` doesn't enumerate methods), but the OpenRPC spec
	 * emitter drops them, so native generators (Swift / Kotlin) never see
	 * them. Use for mock-only / dev-only helpers like `api.getLastCode()`.
	 */
	skipCodegen?: boolean;
	/**
	 * Why part of the return type is described as a plain object (a recursive
	 * type cut, a size limit), for `generate-spec` to print when it uses this
	 * schema. A parameter's are on its {@link ParamTypeInfo.warnings}.
	 */
	returnWarnings?: string[];
}

/**
 * Public so `generate-spec.ts` and any future emitter can share the same
 * vocabulary. Spelt as a single token to avoid hyphenation surprises in
 * JSDoc parsers.
 */
export const BLOCKS_SKIP_CODEGEN_TAG = 'blocksSkipCodegen';

/**
 * **Experimental, for Building Block authors.** JSDoc tag on an exported
 * generic type alias or interface whose type parameters all have defaults:
 * the OpenRPC spec describes every instantiation of the type at its default
 * type arguments (`SignInNextStep<{ mfa: 'off' }>` as `SignInNextStep`).
 *
 * Use it for a type a Building Block narrows per instance for TypeScript
 * callers, by its options, that native clients should see in one shape: two
 * differently configured blocks then generate the same native types. The
 * TypeScript types are unaffected, so the server must enforce the narrowing.
 * `AuthStateApi`, `SignInNextStep`, `MfaPreference` and `MfaPreferenceInput`
 * use it.
 *
 * A misplaced tag (on a type that is not exported at the top level of its
 * file, has no type parameters, or has one without a default) is an error.
 */
export const BLOCKS_CODEGEN_DEFAULT_TYPE_ARGS_TAG = 'blocksCodegenDefaultTypeArgs';

/** A misused {@link BLOCKS_CODEGEN_DEFAULT_TYPE_ARGS_TAG}; `generate-spec` reports it rather than falling back. */
export class CodegenTagError extends Error {
	override readonly name = 'CodegenTagError';
}

/**
 * The default instantiation of each tagged type in the program being read,
 * keyed by {@link taggedKey}. Set for the duration of `extractMethodTypes`.
 */
let defaultInstantiations: Map<string, ts.Type> | undefined;

function taggedKey(decl: ts.Declaration & { name: ts.Identifier }): string {
	return `${decl.getSourceFile().fileName}#${decl.name.text}`;
}

function isDefaultTypeArgsTagged(decl: ts.Node): boolean {
	return ts.getJSDocTags(decl).some((tag) => tag.tagName.text === BLOCKS_CODEGEN_DEFAULT_TYPE_ARGS_TAG);
}

/** The tagged declarations of `program`, checked. Throws {@link CodegenTagError} for a misused tag. */
function findDefaultTypeArgsDeclarations(
	program: ts.Program,
): (ts.TypeAliasDeclaration | ts.InterfaceDeclaration)[] {
	const found: (ts.TypeAliasDeclaration | ts.InterfaceDeclaration)[] = [];
	// Binds every file, which sets the parent pointers `ts.getJSDocTags` walks.
	program.getTypeChecker();
	for (const sf of program.getSourceFiles()) {
		if (!sf.text.includes(`@${BLOCKS_CODEGEN_DEFAULT_TYPE_ARGS_TAG}`)) continue;
		const visit = (node: ts.Node, topLevel: boolean) => {
			if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && isDefaultTypeArgsTagged(node)) {
				const where = `\`${node.name.text}\` (${sf.fileName})`;
				const exported = (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
				if (!topLevel || !exported) {
					throw new CodegenTagError(
						`@${BLOCKS_CODEGEN_DEFAULT_TYPE_ARGS_TAG} on ${where}: the type must be exported at the top level of its file.`,
					);
				}
				const params = node.typeParameters ?? [];
				if (params.length === 0 || params.some((tp) => !tp.default)) {
					throw new CodegenTagError(
						`@${BLOCKS_CODEGEN_DEFAULT_TYPE_ARGS_TAG} on ${where}: every type parameter needs a default (it has ${
							params.length === 0 ? 'none' : params.filter((tp) => !tp.default).map((tp) => tp.name.text).join(', ')
						}${params.length === 0 ? '' : ' without one'}).`,
					);
				}
				found.push(node);
			}
			ts.forEachChild(node, (child) => visit(child, false));
		};
		for (const statement of sf.statements) visit(statement, true);
	}
	return found;
}

const DEFAULTS_SHIM = '__blocks_codegen_default_type_args__.ts';

/**
 * `program` plus a virtual file that names each tagged type at its default
 * type arguments (`export type __default0 = SignInNextStep;`), and the map
 * from each tagged declaration to that type. `program` itself when nothing is
 * tagged.
 */
function withDefaultInstantiations(
	program: ts.Program,
	options: ts.CompilerOptions,
	shimDir: string,
): { program: ts.Program; defaults: Map<string, ts.Type> } {
	const tagged = findDefaultTypeArgsDeclarations(program);
	const defaults = new Map<string, ts.Type>();
	if (tagged.length === 0) return { program, defaults };
	const moduleOf = (fileName: string) => fileName.replace(/(\.d)?\.(m|c)?tsx?$/, '.js');
	const shimPath = join(shimDir, DEFAULTS_SHIM);
	const shim = tagged
		.map(
			(decl, i) =>
				`import type { ${decl.name.text} as __Tagged${i} } from ${JSON.stringify(moduleOf(decl.getSourceFile().fileName))};\n` +
				`export type __default${i} = __Tagged${i};\n`,
		)
		.join('');
	const host = ts.createCompilerHost(options, true);
	const getSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
		resolve(fileName) === shimPath
			? ts.createSourceFile(fileName, shim, languageVersion, true)
			: getSourceFile(fileName, languageVersion, onError, shouldCreate);
	const fileExists = host.fileExists.bind(host);
	host.fileExists = (fileName) => resolve(fileName) === shimPath || fileExists(fileName);
	const extended = ts.createProgram([...program.getRootFileNames(), shimPath], options, host, program);
	const checker = extended.getTypeChecker();
	const shimFile = extended.getSourceFile(shimPath);
	const aliases = new Map<string, ts.TypeAliasDeclaration>();
	for (const statement of shimFile?.statements ?? []) {
		if (ts.isTypeAliasDeclaration(statement)) aliases.set(statement.name.text, statement);
	}
	tagged.forEach((decl, i) => {
		const alias = aliases.get(`__default${i}`);
		const symbol = alias ? checker.getSymbolAtLocation(alias.name) : undefined;
		const type = symbol ? checker.getDeclaredTypeOfSymbol(symbol) : undefined;
		if (!type || type.flags & ts.TypeFlags.Any) {
			throw new CodegenTagError(
				`@${BLOCKS_CODEGEN_DEFAULT_TYPE_ARGS_TAG} on \`${decl.name.text}\` (${decl.getSourceFile().fileName}): its default instantiation could not be resolved.`,
			);
		}
		defaults.set(taggedKey(decl), type);
	});
	return { program: extended, defaults };
}

/**
 * The type `type` is described as: the default instantiation of the tagged
 * generic alias or interface it instantiates, else `undefined`.
 */
function defaultInstantiationOf(type: ts.Type): ts.Type | undefined {
	if (!defaultInstantiations?.size) return undefined;
	// The alias it instantiates (`SignInNextStep<O>`), or the generic interface
	// (`AuthStateApi<I>`, which may also carry an untagged alias such as `AuthStateApiOf<O>`).
	const reference =
		type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference
			? (type as ts.TypeReference).target.symbol
			: undefined;
	const decl = [type.aliasSymbol, reference]
		.flatMap((symbol) => symbol?.declarations ?? [])
		.find(
			(d): d is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
				(ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d)) && isDefaultTypeArgsTagged(d),
		);
	if (!decl) return undefined;
	const wide = defaultInstantiations.get(taggedKey(decl));
	if (!wide) {
		throw new CodegenTagError(
			`@${BLOCKS_CODEGEN_DEFAULT_TYPE_ARGS_TAG} on \`${decl.name.text}\`: no default instantiation was resolved.`,
		);
	}
	return wide === type ? undefined : wide;
}

function hasBlocksSkipCodegenTag(node: ts.Node): boolean {
	for (const tag of ts.getJSDocTags(node)) {
		if (tag.tagName.text === BLOCKS_SKIP_CODEGEN_TAG) return true;
	}
	return false;
}

/**
 * Pure-AST scan for method names tagged with `@blocksSkipCodegen` inside the
 * `ApiNamespace(...)` calls of a TS source file. Returns a Set of method
 * names (the OpenRPC emitter qualifies them by namespace later).
 *
 * Distinct from {@link extractMethodTypes} because that function builds a
 * full `ts.Program` + type checker, and any failure inside type
 * resolution (an imported module that doesn't typecheck, a third-party
 * `.d.ts` mismatch) silently empties the returned Map. The skip set must
 * survive those crashes, so this function uses only the parser.
 */
export function extractSkipCodegenMethods(sourcePath: string): Set<string> {
	const result = new Set<string>();
	const absPath = resolve(sourcePath);
	const fileText = ts.sys.readFile(absPath);
	if (!fileText) return result;

	const sourceFile = ts.createSourceFile(
		absPath,
		fileText,
		ts.ScriptTarget.ESNext,
		/*setParentNodes*/ true,
		ts.ScriptKind.TS,
	);

	function visitObjectLiteral(obj: ts.ObjectLiteralExpression, namespaceName?: string) {
		for (const prop of obj.properties) {
			if (
				ts.isMethodDeclaration(prop) &&
				prop.name &&
				ts.isIdentifier(prop.name) &&
				hasBlocksSkipCodegenTag(prop)
			) {
				// Qualify by namespace (like extractMethodTypes) so a tag on one
				// namespace's `create` doesn't cause another namespace's `create` to be
				// dropped from the spec. Bare key only when the namespace is unknown.
				result.add(namespaceName ? `${namespaceName}.${prop.name.text}` : prop.name.text);
			}
		}
	}

	function visit(node: ts.Node) {
		if (ts.isNewExpression(node)) {
			const callee = node.expression;
			if (ts.isIdentifier(callee) && callee.text === 'ApiNamespace' && node.arguments && node.arguments.length >= 2) {
				const handler = apiNamespaceHandlerArg(node);
				const nsName = enclosingBindingName(node);
				if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
					const body = handler.body;
					if (ts.isParenthesizedExpression(body) && ts.isObjectLiteralExpression(body.expression)) {
						visitObjectLiteral(body.expression, nsName);
					} else if (ts.isObjectLiteralExpression(body)) {
						visitObjectLiteral(body, nsName);
					} else if (ts.isBlock(body)) {
						for (const stmt of body.statements) {
							if (ts.isReturnStatement(stmt) && stmt.expression) {
								if (ts.isObjectLiteralExpression(stmt.expression)) {
									visitObjectLiteral(stmt.expression, nsName);
								} else if (
									ts.isParenthesizedExpression(stmt.expression) &&
									ts.isObjectLiteralExpression(stmt.expression.expression)
								) {
									visitObjectLiteral(stmt.expression.expression, nsName);
								}
							}
						}
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return result;
}

export interface ParamTypeInfo {
	name: string;
	required: boolean;
	schema: JsonSchema;
	/** See {@link MethodTypeInfo.returnWarnings}. */
	warnings?: string[];
}

export interface JsonSchema {
	type?: string;
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema | JsonSchema[];
	required?: string[];
	$ref?: string;
	nullable?: boolean;
	enum?: (string | number | boolean | null)[];
	oneOf?: JsonSchema[];
	additionalProperties?: JsonSchema | boolean;
	title?: string;
	[key: string]: unknown;
}

/**
 * Set on a named object schema to the declaration it comes from
 * (`<file>#<name>`, the file relative to the working directory), so
 * `generate-spec` can tell instantiations of one generic type from two types
 * that share a name, and name both in its warning. Internal: stripped before
 * the spec is written.
 */
export const DECLARATION_MARKER = 'x-blocks-declaration';

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Parse a TypeScript source file with full type checking and extract type
 * info for all methods inside `ApiNamespace(...)` calls.
 *
 * Uses `ts.createProgram` to resolve imports and infer return types.
 * Falls back to AST-only parsing if program creation fails.
 */
export function extractMethodTypes(sourcePath: string): Map<string, MethodTypeInfo> {
	const result = new Map<string, MethodTypeInfo>();
	const absPath = resolve(sourcePath);

	// Find tsconfig.json by walking up from the source file
	const configPath = findTsConfig(dirname(absPath));

	let program: ts.Program;
	let options: ts.CompilerOptions;

	if (configPath) {
		const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
		const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath));
		// Only include our target file — the compiler resolves imports on demand.
		// This is much faster than passing the full fileNames list from tsconfig.
		options = { ...parsed.options, skipLibCheck: true, skipDefaultLibCheck: true };
	} else {
		// No tsconfig — create a minimal program
		options = {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			strict: true,
			esModuleInterop: true,
			skipLibCheck: true,
		};
	}
	// `@blocksCodegenDefaultTypeArgs`: add the tagged types' default instantiations.
	const extended = withDefaultInstantiations(ts.createProgram([absPath], options), options, dirname(absPath));
	program = extended.program;
	defaultInstantiations = extended.defaults;
	finishedSchemas = new Map();
	try {
		return extractFromProgram(program, absPath, result);
	} finally {
		defaultInstantiations = undefined;
	}
}

function extractFromProgram(
	program: ts.Program,
	absPath: string,
	result: Map<string, MethodTypeInfo>,
): Map<string, MethodTypeInfo> {
	const checker = program.getTypeChecker();
	const sourceFile = program.getSourceFile(absPath);
	if (!sourceFile) return result;

	// Find new ApiNamespace(scope, name, handler) and extract methods using the type checker
	ts.forEachChild(sourceFile, function visit(node) {
		if (ts.isNewExpression(node)) {
			const fnName = node.expression;
			if (ts.isIdentifier(fnName) && fnName.text === 'ApiNamespace' && node.arguments && node.arguments.length >= 2) {
				const handlerArg = apiNamespaceHandlerArg(node);
				if (handlerArg) extractMethodsFromHandler(handlerArg, checker, sourceFile!, result, enclosingBindingName(node));
			}
		}
		ts.forEachChild(node, visit);
	});

	// Recursively attribute every leaf identifier in a destructuring binding pattern
	// to the namespace it binds, keyed by the leaf's LOCAL name. Object patterns
	// (`{ ns }`, `{ ns: local }`), array/tuple patterns (`[ns]`), and any nesting
	// (`{ a: { b } }`, `[{ ns }]`) all funnel here. The checker computes the
	// destructuring, so each leaf's resolved type — a tuple element or a nested
	// property — needs no manual index/property bookkeeping (#552).
	function attributeBindingPattern(pattern: ts.BindingPattern): void {
		for (const element of pattern.elements) {
			if (ts.isOmittedExpression(element)) continue; // an array hole, e.g. `const [, ns] = …`
			// A rest binding (`const [a, ...rest]` / `const { a, ...rest }`) resolves to
			// an array/object type whose members (push/map/…) carry call signatures, which
			// would add benign but noisy `rest.push`-style keys. A namespace is never a
			// rest binding, so skip it and keep the map tight.
			if (element.dotDotDotToken) continue;
			if (ts.isIdentifier(element.name)) {
				const elementType = checker.getTypeAtLocation(element.name);
				extractMethodsFromResolvedType(elementType, checker, result, element.name.text);
			} else {
				attributeBindingPattern(element.name); // nested object/array pattern
			}
		}
	}

	// Second pass: resolve types for indirect ApiNamespace exports (e.g., auth.createApi()).
	// The AST walk above only finds `new ApiNamespace(...)` in this file.
	// For methods created by Building Block helpers in other files, use the type
	// checker to resolve the call's return type and extract method signatures.
	ts.forEachChild(sourceFile, (node) => {
		if (!ts.isVariableStatement(node)) return;
		for (const decl of node.declarationList.declarations) {
			if (!decl.initializer) continue;

			// (a) Simple binding: `const api = auth.createApi()` /
			//     `export const api = backend.namespace`.
			if (ts.isIdentifier(decl.name)) {
				// Skip if we already extracted methods for this via the AST walk
				if (ts.isNewExpression(decl.initializer)) {
					const callee = decl.initializer.expression;
					if (ts.isIdentifier(callee) && callee.text === 'ApiNamespace') continue;
				}
				// Use the type checker to get the type of the initializer expression.
				// For `auth.createApi()`, this resolves through the method's return type
				// to the `AsyncAPI<T>` type that ApiNamespace returns.
				const initType = checker.getTypeAtLocation(decl.initializer);
				extractMethodsFromResolvedType(initType, checker, result, decl.name.text);
				continue;
			}

			// (b) Destructuring binding: `const { indirectNamespace } = factory()`,
			// `const [ns] = factory()`, or any nesting of the two. Each destructured
			// binding is a separate namespace whose name is the LOCAL binding name (the
			// name it's exported under), so a factory-returned namespace keys qualified
			// (`indirectNamespace.method`) like a directly-constructed one — instead of
			// landing on a bare key that collides with same-named methods in other
			// namespaces (#444, #445). See `attributeBindingPattern`, which recurses to
			// every leaf identifier so object, array/tuple, and nested patterns are all
			// attributed (#552 — a tuple of namespaces sharing a method name would
			// otherwise hit the #445 cross-assignment class).
			//
			// This adds the qualified key ALONGSIDE the bare key the first-pass AST
			// walk already emitted for the same `new ApiNamespace(...)` (its
			// `enclosingBindingName` returns undefined behind the factory, so it keys
			// bare). Leaving the bare key is harmless: `generate-spec` looks up
			// `tsTypes.get(qualified) ?? tsTypes.get(bare)`, so the qualified key
			// added here always wins for an attributable namespace, and the bare
			// entry never influences the emitted schema (a regression test asserts
			// this under a name collision). The #498 bare-name fallback is retained
			// on purpose — it's the last resort for namespaces this pass still can't
			// attribute (default exports, deeper indirection), so it is NOT redundant.
			if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
				attributeBindingPattern(decl.name);
			}
		}
	});

	return result;
}

// ── tsconfig discovery ──────────────────────────────────────────────────────

function findTsConfig(dir: string): string | undefined {
	let current = dir;
	for (let i = 0; i < 10; i++) {
		const candidate = resolve(current, 'tsconfig.json');
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

// ── Handler extraction ──────────────────────────────────────────────────────

function extractMethodsFromHandler(
	handlerNode: ts.Node,
	checker: ts.TypeChecker,
	sourceFile: ts.SourceFile,
	result: Map<string, MethodTypeInfo>,
	namespaceName?: string,
): void {
	let objectLiteral: ts.ObjectLiteralExpression | undefined;

	if (ts.isArrowFunction(handlerNode) || ts.isFunctionExpression(handlerNode)) {
		const body = handlerNode.body;
		if (ts.isParenthesizedExpression(body)) {
			if (ts.isObjectLiteralExpression(body.expression)) {
				objectLiteral = body.expression;
			}
		} else if (ts.isObjectLiteralExpression(body)) {
			objectLiteral = body;
		} else if (ts.isBlock(body)) {
			for (const stmt of body.statements) {
				if (ts.isReturnStatement(stmt) && stmt.expression) {
					if (ts.isObjectLiteralExpression(stmt.expression)) {
						objectLiteral = stmt.expression;
					} else if (ts.isParenthesizedExpression(stmt.expression) &&
						ts.isObjectLiteralExpression(stmt.expression.expression)) {
						objectLiteral = stmt.expression.expression;
					}
				}
			}
		}
	}

	if (!objectLiteral) return;

	for (const prop of objectLiteral.properties) {
		if (ts.isMethodDeclaration(prop) && prop.name && ts.isIdentifier(prop.name)) {
			const methodName = prop.name.text;
			const info = describeOrWarn(namespaceName ? `${namespaceName}.${methodName}` : methodName, () =>
				extractMethodTypeInfo(prop, checker, sourceFile),
			);
			// Key by the namespace-qualified name when the namespace is known, so two
			// namespaces sharing a method name (e.g. widgets.create / subscriptions.create)
			// don't collide and cross-assign schemas. Fall back to the bare name when the
			// namespace can't be determined (consumers try qualified, then bare).
			if (info) result.set(namespaceName ? `${namespaceName}.${methodName}` : methodName, info);
		}
	}
}

/**
 * Walk up from a `new ApiNamespace(...)` node to the name it's bound to
 * (`export const widgets = new ApiNamespace(...)` → `"widgets"`). This is the
 * name the dev server / Lambda handler route by, and the one `generate-spec`
 * uses to qualify method names. Returns `undefined` when the namespace is
 * created behind indirection (factory return, etc.), in which case methods key
 * by their bare name.
 *
 * Limitation: this is the local binding name, not the export name. An export
 * rename — `const widgets = new ApiNamespace(...); export { widgets as gadgets }`
 * — keys `widgets.*` while `generate-spec` looks up `gadgets.*`, so the qualified
 * lookup misses and falls back to the bare key (schemas resolve if there's no
 * collision, else `unknown`). Rare; resolving the export alias would remove it.
 */
function enclosingBindingName(node: ts.Node): string | undefined {
	let current: ts.Node | undefined = node.parent;
	while (current) {
		if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
		// Don't cross a function/block boundary — beyond it the binding no longer
		// corresponds to a directly-exported namespace.
		if (ts.isSourceFile(current) || ts.isBlock(current) || ts.isFunctionLike(current)) return undefined;
		current = current.parent;
	}
	return undefined;
}

function extractMethodTypeInfo(
	method: ts.MethodDeclaration,
	checker: ts.TypeChecker,
	sourceFile: ts.SourceFile,
): MethodTypeInfo | null {
	const params: ParamTypeInfo[] = [];

	for (const param of method.parameters) {
		const name = ts.isIdentifier(param.name) ? param.name.text
			: param.name.getText(sourceFile);
		const required = !param.questionToken && !param.initializer;

		// Use the type checker to get the resolved type (handles imported types, aliases, etc.)
		const symbol = checker.getSymbolAtLocation(param.name);
		let schema: JsonSchema = { type: 'unknown' };
		let warnings: string[] | undefined;
		if (symbol) {
			const paramType = checker.getTypeOfSymbolAtLocation(symbol, param);
			({ schema, warnings } = topLevelSchemaWithWarnings(paramType, checker, `${method.name.getText(sourceFile)}(${name})`));
		} else if (param.type) {
			// Fallback to AST-based extraction
			schema = typeNodeToJsonSchema(param.type, sourceFile);
		}
		params.push({ name, required, schema, ...(warnings ? { warnings } : {}) });
	}

	// Return type: use the type checker to get the inferred return type
	let returnType: JsonSchema = { type: 'unknown' };
	let returnWarnings: string[] | undefined;
	let transferable: TransferableInfo | undefined;
	const signature = checker.getSignatureFromDeclaration(method);
	if (signature) {
		let retType = checker.getReturnTypeOfSignature(signature);
		// Unwrap Promise<T>
		retType = unwrapPromise(retType, checker);
		// Check if the return type is a transferable before converting to schema.
		// Pass the syntactic return-type node so we can distinguish between
		// `RealtimeChannel` (default `T = unknown` filled in) and
		// `RealtimeChannel<unknown>` (explicit) — the resolved `ts.Type` looks
		// identical for both, but only the latter should emit `typeArgs: [{}]`.
		const retTypeNode = unwrapPromiseTypeNode(method.type);
		transferable = detectTransferable(retType, checker, retTypeNode);
		({ schema: returnType, warnings: returnWarnings } = topLevelSchemaWithWarnings(
			retType,
			checker,
			`${method.name.getText(sourceFile)}()`,
		));
	}

	const skipCodegen = hasBlocksSkipCodegenTag(method) || undefined;
	return { params, returnType, transferable, skipCodegen, ...(returnWarnings ? { returnWarnings } : {}) };
}

function unwrapParens(node: ts.TypeNode | undefined): ts.TypeNode | undefined {
	let current = node;
	while (current && ts.isParenthesizedTypeNode(current)) current = current.type;
	return current;
}

/**
 * The written type reference inside an async return annotation, found through any
 * parentheses and a single `Promise<T>` layer. Used to recover the type arguments the
 * customer wrote: `Promise<RealtimeChannel>` has no inner `<...>`, `Promise<RealtimeChannel<X>>` does.
 */
function unwrapPromiseTypeNode(node: ts.TypeNode | undefined): ts.TypeReferenceNode | undefined {
	const written = unwrapParens(node);
	if (!written || !ts.isTypeReferenceNode(written)) return undefined;
	const name = ts.isIdentifier(written.typeName) ? written.typeName.text : written.typeName.getText();
	if (name === 'Promise' && written.typeArguments && written.typeArguments.length === 1) {
		const inner = unwrapParens(written.typeArguments[0]);
		return inner && ts.isTypeReferenceNode(inner) ? inner : undefined;
	}
	return written;
}

// ── Type-checker-based extraction for indirect ApiNamespace calls ────────────

/**
 * Extract method type info from a resolved `ts.Type` (e.g., the return type
 * of `auth.createApi()`). This handles the case where `ApiNamespace(...)` is
 * called inside another module — the AST walk can't see it, but the type
 * checker resolves the full return type including method signatures.
 *
 * The type is the `AsyncAPI<T>` wrapper returned by `ApiNamespace`, which is
 * a mapped type where each property is `(...args: Args) => Promise<R>`.
 * We also handle the case where the type is callable (the raw handler function
 * before `AsyncAPI` wrapping) — we call-resolve it and inspect the result.
 */
function extractMethodsFromResolvedType(
	type: ts.Type,
	checker: ts.TypeChecker,
	result: Map<string, MethodTypeInfo>,
	namespaceName?: string,
): void {
	// The runtime value of an ApiNamespace export is the handler function itself
	// (with the marker symbol attached). Its TS type is `AsyncAPI<T>`, which is
	// an object type with method-like properties. But it could also be typed as
	// the handler function `(context: BlocksContext) => T`. Try both:
	// 1. If the type has call signatures, resolve the return type (handler fn case)
	// 2. Otherwise, treat it as the AsyncAPI<T> object directly

	// `@blocksCodegenDefaultTypeArgs` on the namespace's interface (`AuthStateApi`).
	let methodsType = defaultInstantiationOf(type) ?? type;

	// If the type is callable (handler function), resolve its return type
	const callSigs = type.getCallSignatures();
	if (callSigs.length > 0) {
		const retType = checker.getReturnTypeOfSignature(callSigs[0]);
		// The return type should be the object with method properties
		if (retType.getProperties().length > 0) {
			methodsType = retType;
		}
	}

	const props = methodsType.getProperties();
	if (props.length === 0) return;

	for (const prop of props) {
		const propName = prop.getName();
		// Skip internal symbols and the marker
		if (propName.startsWith('_') || propName === 'Symbol(blocks:ApiNamespace)') continue;
		const key = namespaceName ? `${namespaceName}.${propName}` : propName;
		// Don't overwrite methods already found by the AST walk
		if (result.has(key)) continue;

		const info = describeOrWarn(key, (): MethodTypeInfo | undefined => {
			const propType = checker.getTypeOfSymbol(prop);
			const methodSigs = propType.getCallSignatures();
			if (methodSigs.length === 0) return undefined;

			const sig = methodSigs[0];

			// Extract params
			const params: ParamTypeInfo[] = [];
			for (const paramSymbol of sig.getParameters()) {
				const paramType = checker.getTypeOfSymbol(paramSymbol);
				const { schema, warnings } = topLevelSchemaWithWarnings(
					paramType,
					checker,
					`${prop.getName()}(${paramSymbol.getName()})`,
				);
				const paramDecl = paramSymbol.valueDeclaration;
				const isOptional = paramDecl && ts.isParameter(paramDecl)
					? !!(paramDecl.questionToken || paramDecl.initializer)
					: (paramSymbol.flags & ts.SymbolFlags.Optional) !== 0;
				params.push({
					name: paramSymbol.getName(),
					required: !isOptional,
					schema,
					...(warnings ? { warnings } : {}),
				});
			}

			// Extract return type (unwrap Promise<T>)
			let retType = checker.getReturnTypeOfSignature(sig);
			retType = unwrapPromise(retType, checker);
			// `sig.declaration` is not usable here: on the `AsyncAPI<T>` mapped-type path it
			// resolves to the mapper's own `Promise<Awaited<R>>`, so unwrapping it yields
			// `Awaited<R>` and reports that node's own argument, `R`, as customer-written.
			const transferable = detectTransferable(retType, checker, syntacticReturnTypeNode(prop));
			const { schema: returnType, warnings: returnWarnings } = topLevelSchemaWithWarnings(
				retType,
				checker,
				`${prop.getName()}()`,
			);

			// JSDoc lives on the original method declaration, which we can reach
			// via the symbol's `valueDeclaration` (the `MethodDeclaration` node in
			// the BB-helper file that minted the AsyncAPI<T> shape).
			let skipCodegen: true | undefined;
			const declaration = prop.valueDeclaration;
			if (declaration && hasBlocksSkipCodegenTag(declaration)) {
				skipCodegen = true;
			}

			return { params, returnType, transferable, skipCodegen, ...(returnWarnings ? { returnWarnings } : {}) };
		});
		if (info) result.set(key, info);
	}
}

/**
 * A mapped-type property has no `valueDeclaration`, so fall back to its sole
 * declaration; several would give no single annotation to pick.
 */
function syntacticReturnTypeNode(prop: ts.Symbol): ts.TypeReferenceNode | undefined {
	const decl = prop.valueDeclaration ?? (prop.declarations?.length === 1 ? prop.declarations[0] : undefined);
	if (!decl) return undefined;
	if (ts.isMethodSignature(decl) || ts.isMethodDeclaration(decl)) return unwrapPromiseTypeNode(decl.type);
	if (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) {
		const annotation = unwrapParens(decl.type);
		return annotation && ts.isFunctionTypeNode(annotation) ? unwrapPromiseTypeNode(annotation.type) : undefined;
	}
	if (ts.isPropertyAssignment(decl)) {
		const init = decl.initializer;
		if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return unwrapPromiseTypeNode(init.type);
	}
	return undefined;
}

// ── Transferable detection ───────────────────────────────────────────────────

/**
 * Inspect a resolved ts.Type for the transferable protocol:
 * - Has a method named `toJSON`
 * - toJSON's return type has a property `__blocks` with a string LITERAL type
 *
 * If detected, extracts the blocks tag and resolves generic type arguments.
 * Returns undefined if the type is not transferable.
 *
 * `syntacticNode` is the AST `TypeReferenceNode` the customer wrote (e.g.
 * `RealtimeChannel<CursorPosition>`). It's passed in alongside the resolved
 * `ts.Type` so we can tell the difference between an unwritten default
 * (`RealtimeChannel`, where `T = unknown` is filled in by the checker) and
 * an explicit `RealtimeChannel<unknown>`. The two look identical in the
 * resolved `ts.Type`, but only the explicit form should emit a `[{}]` slot.
 *
 * An `oidc/client` also emits the arguments the checker infers, when they
 * resolve to string literals: `AuthOIDC.createApi()` types `getClient()` as
 * `OIDCClient<ProviderName<P>>`, which resolves to `OIDCClient<'google' | 'github'>`.
 */
function detectTransferable(
	type: ts.Type,
	checker: ts.TypeChecker,
	syntacticNode?: ts.TypeReferenceNode,
): TransferableInfo | undefined {
	// Step 1-2: Get properties of the type and find `toJSON`
	const props = checker.getPropertiesOfType(type);
	const toJsonSymbol = props.find(p => p.getName() === 'toJSON');
	if (!toJsonSymbol) return undefined;

	// Step 3: Get the type of `toJSON`
	const toJsonType = checker.getTypeOfSymbol(toJsonSymbol);

	// Step 4: Get call signatures of the `toJSON` type
	const callSignatures = toJsonType.getCallSignatures();
	if (callSignatures.length === 0) return undefined;

	// Step 5: Get the return type of the first call signature
	const returnType = checker.getReturnTypeOfSignature(callSignatures[0]);

	// Step 6: Get properties of the return type, find `__blocks`
	const returnProps = checker.getPropertiesOfType(returnType);
	const blocksSymbol = returnProps.find(p => p.getName() === '__blocks');
	if (!blocksSymbol) return undefined;

	// Step 7: Get the type of `__blocks`
	const blocksType = checker.getTypeOfSymbol(blocksSymbol);

	// Step 8: Check if it's a string literal type
	if (!(blocksType.getFlags() & ts.TypeFlags.StringLiteral)) return undefined;

	// Step 9: Extract the literal value as `blocksTag`
	const blocksTag = (blocksType as ts.StringLiteralType).value;

	// Step 10-11: For generic type arguments — only emit them when the
	// customer actually wrote `<...>` in the source. If `syntacticNode` has
	// no `typeArguments`, treat the type as non-generic (defaults filled in
	// by the checker shouldn't appear in the spec), except for the inferred
	// provider names of an `oidc/client`.
	const typeArgs: JsonSchema[] = [];
	// All or nothing: a partial list would pass the arity check with the wrong types in it,
	// since a dropped argument shifts the rest left. A trailing parameter filled from its
	// default, or a wrapper the checker resolves away (the `Awaited<T>` in
	// `Promise<Awaited<R>>`), leaves an argument nobody wrote. `===` is the right compare
	// here: one checker interns its types, so the written node and the resolved argument
	// are the same instance. A structural compare would accept a wrapper's own argument.
	// This tightens both callers, not only the resolved-type one: emission used to need
	// any written type argument, and now needs every one of them.
	const writtenArgs = syntacticNode?.typeArguments ?? [];
	const resolvedArgs = (type as ts.TypeReference).typeArguments ?? [];
	const customerWroteEvery =
		writtenArgs.length === resolvedArgs.length &&
		writtenArgs.every((written, index) => checker.getTypeFromTypeNode(written) === resolvedArgs[index]);
	if (customerWroteEvery) {
		for (const arg of resolvedArgs) {
			// Explicit `unknown` / `any` → empty schema (matches Req 4.3).
			const argFlags = arg.getFlags();
			if (argFlags & ts.TypeFlags.Unknown || argFlags & ts.TypeFlags.Any) {
				typeArgs.push({});
			} else {
				typeArgs.push(topLevelSchema(arg, checker));
			}
		}
	} else if (blocksTag === 'oidc/client') {
		typeArgs.push(...inferredProviderNames(type, checker));
	}

	return { blocksTag, typeArgs };
}

/**
 * An `oidc/client`'s inferred type argument as a string enum of provider
 * names, which native generators turn into a provider type. Empty unless it
 * resolves to string literals: the `string` default, `any`, or an unresolved
 * type parameter names no providers. Other tags emit only written arguments,
 * since an inferred realtime message type can be `any` or a shape a native
 * generator can't decode.
 */
function inferredProviderNames(type: ts.Type, checker: ts.TypeChecker): JsonSchema[] {
	if (!(type.getFlags() & ts.TypeFlags.Object)) return [];
	if (!((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference)) return [];
	const typeRef = type as ts.TypeReference;
	// Arguments for the enclosing scope's type parameters come first, and a `this` argument may follow.
	const outer = typeRef.target.outerTypeParameters?.length ?? 0;
	const local = typeRef.target.localTypeParameters?.length ?? 0;
	const args = checker.getTypeArguments(typeRef).slice(outer, outer + local);
	const schemas = args.map((arg) => tsTypeToJsonSchema(arg, checker));
	const namesProviders = (schema: JsonSchema) => schema.type === 'string' && Array.isArray(schema.enum);
	return schemas.every(namesProviders) ? schemas : [];
}

// ── ts.Type → JSON Schema conversion ────────────────────────────────────────

/**
 * Nesting guard, counted from the nearest enclosing named type: a named type
 * becomes its own component, so its schema is the same wherever it appears
 * (a sign-in step's `CodeDeliveryDetails` deep inside a result union, or at
 * the top of another). A recursive named type is cut after a few levels (see
 * `objectTypeToJsonSchema`), so the limit only bounds anonymous nesting: an
 * unnamed object past it is an open map (see {@link cutSchema}) and an array
 * of unnamed objects or arrays an array of any values, with a warning;
 * primitives, named types and arrays of them past it are described as usual.
 */
const MAX_DEPTH = 6;
/** The absolute stop for nesting that neither an object nor an array cut ends. */
const MAX_UNNAMED_DEPTH = 32;

/**
 * The named types and generic declarations being converted, one inside
 * another, and how many entries on the current path were a repeat. A recursive
 * type (`interface Comment { replies: Comment[] }`) or mutually recursive types
 * repeat the same type: past {@link MAX_RECURSION} repeats on one path the next
 * is cut, so a directly recursive type keeps four typed levels (at least what
 * the old six-level depth limit gave it). A generic that holds a new
 * instantiation of itself (`interface Nest<T> { inner?: Nest<T[]> }`) repeats
 * its declaration with a new type each level: past
 * {@link MAX_NESTED_INSTANTIATIONS} it is cut (`Box<Box<string>>` and the like
 * stay well under). A cut is an open map (see {@link cutSchema}) and prints a
 * warning naming the field. (Not a `$ref` to its own component: the Kotlin
 * generator cannot yet generate a self-referencing type.)
 */
const typesInProgress = new Map<ts.Type, number>();
const declarationsInProgress = new Map<ts.Symbol, number>();
let recursionRepeats = 0;
let instantiationRepeats = 0;
const MAX_RECURSION = 3;
const MAX_NESTED_INSTANTIATIONS = 8;
/** The named types being converted, outermost first: what a cut warning counts its levels on. */
const pathInProgress: { type: ts.Type; declaration: ts.Symbol | undefined }[] = [];

/**
 * How many typed levels the recursion being cut kept: the path from the
 * outermost type that repeats on it (`A` for `A` → `B` → `A` → …), so a
 * mutually recursive pair counts both of its types.
 */
function recursionLevels(same: (entry: (typeof pathInProgress)[number]) => boolean): number {
	const start = pathInProgress.findIndex(
		(entry, i) => same(entry) || pathInProgress.slice(i + 1).some((later) => later.type === entry.type),
	);
	return start < 0 ? 0 : pathInProgress.length - start;
}

/**
 * What a cut type is described as: an object with any fields, so a native
 * client keeps the data (Kotlin `Map<String, JsonElement>`, Swift
 * `[String: JSONValue]`) rather than an empty type that drops it or does not
 * compile.
 */
function cutSchema(): JsonSchema {
	return { type: 'object', additionalProperties: { type: 'unknown' } };
}

/**
 * Each named type's finished schema, so a type reached by many paths (a DAG of
 * types) is converted once, not once per path. Only a schema no cut touched
 * goes in: a cut depends on where the type was reached from.
 */
let finishedSchemas = new Map<ts.Type, { schema: JsonSchema; warnings: [string, string][] }>();
/** The named types being converted whose schema a cut below them made path-dependent. */
const taintedFrames: boolean[] = [];
/**
 * The warnings raised while each named type being converted was, so a schema
 * that reuses its finished schema warns the same (a depth cut does not taint).
 */
const frameWarnings: [string, string][][] = [];

/** Mark every named type being converted as path-dependent (a cut happened inside them). */
function taintPath(): void {
	for (let i = 0; i < taintedFrames.length; i++) taintedFrames[i] = true;
}

/** Named types nested at once, however deep: the absolute stop. */
let namedDepth = 0;
const MAX_NAMED_DEPTH = 64;

/**
 * Named-type expansions in one top-level schema (a parameter or a result). A
 * type whose many fields each lead back to it would otherwise grow as
 * fields^levels; past this budget, further named types are cut, with a warning.
 */
let expansions = 0;
const MAX_EXPANSIONS = 5_000;

/**
 * The property being converted, for the cut warnings: from the nearest named
 * type (`Comment.replies`), else from the method parameter or result
 * (`tableQuery(args).0.where.between`).
 */
let currentField = '';
/** The cut warnings of the schema being converted, each once (see {@link topLevelSchema}). */
let cutWarnings = new Map<string, string>();

function warnCut(key: string, message: string): void {
	const warning = `[blocks] ${message}`;
	if (!cutWarnings.has(key)) cutWarnings.set(key, warning);
	for (const frame of frameWarnings) frame.push([key, warning]);
}

/** A string, number, boolean, null or literal type, or a union of only those: nothing to nest. */
function isPrimitiveLike(type: ts.Type): boolean {
	if (type.isUnion()) return type.types.every(isPrimitiveLike);
	const primitive =
		ts.TypeFlags.StringLike |
		ts.TypeFlags.NumberLike |
		ts.TypeFlags.BooleanLike |
		ts.TypeFlags.Null |
		ts.TypeFlags.Undefined |
		ts.TypeFlags.Void;
	return (type.getFlags() & primitive) !== 0;
}

/** A named object type that is data (not a function): its own component, whatever the depth. */
function isNamedData(type: ts.Type): boolean {
	return schemaTitleOf(type) !== undefined && type.getCallSignatures().length === 0;
}

/** What an array past {@link MAX_DEPTH} may hold and keep its type: primitives and named types (not arrays). */
function keepsTypePastLimit(type: ts.Type, checker: ts.TypeChecker): boolean {
	if (type.isUnion()) return type.types.every((t) => keepsTypePastLimit(t, checker));
	if (isPrimitiveLike(type)) return true;
	const object = (type.getFlags() & ts.TypeFlags.Object) !== 0;
	return object && !checker.isArrayType(type) && !checker.isTupleType(type) && isNamedData(type);
}

/** The warning for an unnamed object or array past {@link MAX_DEPTH}, once per field. */
function warnDeep(): void {
	warnCut(
		`depth:${currentField}`,
		`${currentField ? `\`${currentField}\`` : 'A parameter or result'} nests unnamed objects or arrays more than ${MAX_DEPTH} levels deep; the OpenRPC spec describes the deeper ones as an object with any fields or an array of any values. Declare one of the enclosing object types as an interface to describe it in full.`,
	);
}

/**
 * `describe()` for one method, or `undefined` with a warning naming it when
 * its types cannot be described (the spec then gives that method `unknown`,
 * and every other method keeps its types). A misused codegen tag is rethrown.
 *
 * @internal
 */
export function describeOrWarn<T>(method: string, describe: () => T | undefined): T | undefined {
	try {
		return describe();
	} catch (e) {
		if (e instanceof CodegenTagError) throw e;
		console.warn(
			`[blocks] Could not describe the types of ${method} (${e instanceof Error ? e.message : String(e)}); the OpenRPC spec describes it as unknown.`,
		);
		return undefined;
	}
}

/**
 * Convert a resolved `ts.Type` to JSON Schema.
 * This handles inferred types, imported types, type aliases, etc.
 */
/** The top-level schema whose budget {@link warnCut} reports, so it warns once per schema. */
let budgetOwner = 0;

/**
 * A parameter's or result's schema, with one budget of {@link MAX_EXPANSIONS}
 * named types, and the warnings for what it cut (printed by `generate-spec`
 * only for a schema it uses).
 */
function topLevelSchemaWithWarnings(
	type: ts.Type,
	checker: ts.TypeChecker,
	label = '',
): { schema: JsonSchema; warnings?: string[] } {
	expansions = 0;
	currentField = label;
	budgetOwner++;
	cutWarnings = new Map();
	const schema = tsTypeToJsonSchema(type, checker);
	return cutWarnings.size > 0 ? { schema, warnings: [...cutWarnings.values()] } : { schema };
}

/** {@link topLevelSchemaWithWarnings}, printing its warnings (a transferable's type arguments). */
function topLevelSchema(type: ts.Type, checker: ts.TypeChecker): JsonSchema {
	const { schema, warnings } = topLevelSchemaWithWarnings(type, checker);
	for (const warning of warnings ?? []) console.warn(warning);
	return schema;
}

function tsTypeToJsonSchema(type: ts.Type, checker: ts.TypeChecker, depth = 0): JsonSchema {
	// A safety net: every unnamed object and array past MAX_DEPTH is cut.
	if (depth > MAX_UNNAMED_DEPTH) {
		warnCut(
			`depth:${currentField}`,
			`The type at ${currentField ? `\`${currentField}\`` : 'a parameter or result'} nests past ${MAX_UNNAMED_DEPTH} levels with no object; the OpenRPC spec describes it as unknown.`,
		);
		return { type: 'unknown' };
	}

	// `@blocksCodegenDefaultTypeArgs`: a per-instance narrowing described at
	// its default type arguments (the default maps to itself, so this stops).
	const atDefaults = defaultInstantiationOf(type);
	if (atDefaults) return tsTypeToJsonSchema(atDefaults, checker, depth);

	const flags = type.getFlags();

	// Primitives
	if (flags & ts.TypeFlags.String) return { type: 'string' };
	if (flags & ts.TypeFlags.Number) return { type: 'number' };
	if (flags & ts.TypeFlags.Boolean) return { type: 'boolean' };
	if (flags & ts.TypeFlags.Null) return { type: 'null' };
	if (flags & ts.TypeFlags.Undefined) return { type: 'null' };
	if (flags & ts.TypeFlags.Void) return { type: 'null' };
	if (flags & ts.TypeFlags.Any) return {};
	if (flags & ts.TypeFlags.Unknown) return { type: 'unknown' };
	if (flags & ts.TypeFlags.Never) return { type: 'unknown' };

	// String/number/boolean literal
	if (flags & ts.TypeFlags.StringLiteral) {
		return { type: 'string', enum: [(type as ts.StringLiteralType).value] };
	}
	if (flags & ts.TypeFlags.NumberLiteral) {
		return { type: 'number', enum: [(type as ts.NumberLiteralType).value] };
	}
	if (flags & ts.TypeFlags.BooleanLiteral) {
		// ts.TypeFlags doesn't expose the value directly; use the intrinsicName
		const intrinsic = (type as any).intrinsicName;
		if (intrinsic === 'true') return { type: 'boolean', enum: [true] };
		if (intrinsic === 'false') return { type: 'boolean', enum: [false] };
		return { type: 'boolean' };
	}

	// Union type
	if (type.isUnion()) {
		return unionTypeToJsonSchema(type, checker, depth);
	}

	// Intersection type. Merge fixed properties from each arm and also
	// preserve `additionalProperties` if any arm contributes an index
	// signature (e.g. `{ username; password } & Record<string, string>`).
	// This is how Cognito sign-up declares an open shape — without merging
	// the index signature, native client codegen drops every key the
	// type system can't statically enumerate (email, custom:*, etc.) and
	// the wire format ends up missing them.
	if (type.isIntersection()) {
		const allProps: Record<string, JsonSchema> = {};
		const allRequired: string[] = [];
		let additionalProps: JsonSchema | undefined;
		for (const member of type.types) {
			const schema = tsTypeToJsonSchema(member, checker, depth + 1);
			if (schema.properties) {
				Object.assign(allProps, schema.properties);
				if (schema.required) allRequired.push(...schema.required);
			}
			if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
				additionalProps = schema.additionalProperties as JsonSchema;
			}
		}
		if (Object.keys(allProps).length > 0) {
			const schema: JsonSchema = { type: 'object', properties: allProps };
			if (allRequired.length > 0) schema.required = allRequired;
			if (additionalProps) schema.additionalProperties = additionalProps;
			return schema;
		}
		if (additionalProps) {
			return { type: 'object', additionalProperties: additionalProps };
		}
		return { type: 'object' };
	}

	// Array type
	if (checker.isArrayType(type)) {
		const typeArgs = (type as ts.TypeReference).typeArguments;
		// Past the nesting limit, an array of unnamed objects or arrays is an array of any values (it
		// keeps the data, as an unnamed object's open map does); an array of primitives or named types
		// keeps its type.
		if (depth > MAX_DEPTH && !(typeArgs?.length === 1 && keepsTypePastLimit(typeArgs[0], checker))) {
			warnDeep();
			return { type: 'array', items: { type: 'unknown' } };
		}
		if (typeArgs && typeArgs.length === 1) {
			return { type: 'array', items: tsTypeToJsonSchema(typeArgs[0], checker, depth + 1) };
		}
		return { type: 'array' };
	}

	// Object type (interfaces, type literals, classes)
	if (flags & ts.TypeFlags.Object) {
		// Special-case built-in types that serialize to JSON primitives.
		// Without this, Date emits as an object with getTime/toISOString/etc. properties.
		const symbol = type.getSymbol();
		const typeName = symbol?.getName();
		if (typeName === 'Date') return { type: 'string', format: 'date-time' };
		if (typeName === 'RegExp') return { type: 'string', format: 'regex' };
		if (typeName === 'URL') return { type: 'string', format: 'uri' };
		if (typeName === 'Buffer' || typeName === 'ArrayBuffer' || typeName === 'Uint8Array') return { type: 'string', format: 'binary' };

		// Past the nesting limit an unnamed object keeps its data as an open map. (The
		// depth is counted from the nearest named type, so this is the same on every path.)
		if (depth > MAX_DEPTH && !isNamedData(type)) {
			warnDeep();
			return cutSchema();
		}

		return objectTypeToJsonSchema(type as ts.ObjectType, checker, depth);
	}

	return { type: 'unknown' };
}

function objectTypeToJsonSchema(type: ts.ObjectType, checker: ts.TypeChecker, depth: number): JsonSchema {
	const name = schemaTitleOf(type);
	// Anonymous types, and functions (a method's type is named after the method,
	// and is not data a native client decodes), nest within the depth limit.
	if (!name || type.getCallSignatures().length > 0) return objectTypeBody(type, checker, depth);
	const finished = finishedSchemas.get(type);
	if (finished) {
		for (const [key, warning] of finished.warnings) {
			if (!cutWarnings.has(key)) cutWarnings.set(key, warning);
			for (const frame of frameWarnings) frame.push([key, warning]);
		}
		return finished.schema;
	}
	const declaration =
		(type.objectFlags & ts.ObjectFlags.Reference ? (type as ts.TypeReference).target.symbol : undefined) ??
		type.aliasSymbol ??
		type.getSymbol();
	// Recursion, an expanding generic, or a named-type chain past any real API's:
	// stop rather than expand forever.
	const typeUses = typesInProgress.get(type) ?? 0;
	const declarationUses = declaration ? (declarationsInProgress.get(declaration) ?? 0) : 0;
	const recursion = typeUses > 0;
	const instantiation = !recursion && declarationUses > 0;
	const where = currentField ? ` at \`${currentField}\`` : '';
	if ((recursion && recursionRepeats >= MAX_RECURSION) || (instantiation && instantiationRepeats >= MAX_NESTED_INSTANTIATIONS)) {
		warnCut(
			`nested:${name}`,
			`\`${name}\` nests itself${where}; the OpenRPC spec describes it ${recursionLevels((entry) =>
				recursion ? entry.type === type : entry.declaration === declaration,
			)} levels deep, then as an object with any fields.`,
		);
		taintPath();
		return cutSchema();
	}
	if (namedDepth >= MAX_NAMED_DEPTH || expansions >= MAX_EXPANSIONS) {
		warnCut(
			`budget:${budgetOwner}`,
			`\`${name}\`${where} is past the OpenRPC spec generator's limit of ${
				namedDepth >= MAX_NAMED_DEPTH ? `${MAX_NAMED_DEPTH} nested named types` : `${MAX_EXPANSIONS} named types in one schema`
			}; it is described as an object with any fields.`,
		);
		taintPath();
		return cutSchema();
	}
	expansions++;
	typesInProgress.set(type, typeUses + 1);
	if (declaration) declarationsInProgress.set(declaration, declarationUses + 1);
	if (recursion) recursionRepeats++;
	if (instantiation) instantiationRepeats++;
	namedDepth++;
	pathInProgress.push({ type, declaration });
	taintedFrames.push(false);
	const warnings: [string, string][] = [];
	frameWarnings.push(warnings);
	let tainted = true;
	try {
		const schema = objectTypeBody(type, checker, 0);
		tainted = taintedFrames[taintedFrames.length - 1] ?? true;
		if (!tainted) finishedSchemas.set(type, { schema, warnings });
		return schema;
	} finally {
		frameWarnings.pop();
		taintedFrames.pop();
		pathInProgress.pop();
		namedDepth--;
		if (recursion) recursionRepeats--;
		if (instantiation) instantiationRepeats--;
		if (typeUses === 0) typesInProgress.delete(type);
		else typesInProgress.set(type, typeUses);
		if (declaration) {
			if (declarationUses === 0) declarationsInProgress.delete(declaration);
			else declarationsInProgress.set(declaration, declarationUses);
		}
	}
}

/** The `title` a named object type's schema gets (interfaces, type aliases), else `undefined`. */
function schemaTitleOf(type: ts.Type): string | undefined {
	const name = (type.getSymbol() || type.aliasSymbol)?.getName();
	return name && name !== '__type' && name !== '__object' && !name.startsWith('__') ? name : undefined;
}

function objectTypeBody(type: ts.ObjectType, checker: ts.TypeChecker, depth: number): JsonSchema {
	const properties: Record<string, JsonSchema> = {};
	const required: string[] = [];

	const props = checker.getPropertiesOfType(type);

	// Index signatures (`Record<string, V>` or `{ [key: string]: V }`) carry
	// the value type for any unnamed key. Capture once up front so we can
	// emit `additionalProperties` on both the pure-map case (no fixed
	// properties) and the mixed case (fixed properties + index sig).
	const stringIndexType = checker.getIndexTypeOfType(type, ts.IndexKind.String);
	const additionalProps: JsonSchema | undefined = stringIndexType
		? tsTypeToJsonSchema(stringIndexType, checker, depth + 1)
		: undefined;

	if (props.length === 0 && additionalProps) {
		return { type: 'object', additionalProperties: additionalProps };
	}

	if (props.length === 0) return { type: 'object' };

	for (const prop of props) {
		// Skip internal/private properties
		if (prop.name.startsWith('_')) continue;

		// Mapped-type properties (e.g. from `Partial<Record<K, V>>` and the
		// per-variant intersections produced when unioning over an action
		// payload map) are synthetic and have no `valueDeclaration`. Casting
		// the `Symbol` to a `ts.Node` to satisfy `getTypeOfSymbolAtLocation`
		// crashes inside the compiler's `isDeclaration` walk. `getTypeOfSymbol`
		// resolves the property type without a location and works for both
		// real and synthetic properties.
		const propType = checker.getTypeOfSymbol(prop);
		const outerField = currentField;
		currentField = `${schemaTitleOf(type) ?? (outerField || 'object')}.${prop.name}`;
		let propSchema: JsonSchema;
		try {
			propSchema = tsTypeToJsonSchema(propType, checker, depth + 1);
		} finally {
			currentField = outerField;
		}
		properties[prop.name] = propSchema;

		const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
		if (!isOptional) {
			required.push(prop.name);
		}
	}

	const schema: JsonSchema = { type: 'object', properties };
	if (required.length > 0) schema.required = required;
	if (additionalProps) schema.additionalProperties = additionalProps;

	// Preserve the original type name for named types (interfaces, type aliases).
	// This enables $ref extraction in generate-spec.ts and Phase 4 hydration detection.
	// Anonymous/synthetic names are skipped.
	const name = schemaTitleOf(type);
	if (name) {
		schema.title = name;
		const declaration = (type.getSymbol() || type.aliasSymbol)?.declarations?.[0];
		if (declaration) {
			schema[DECLARATION_MARKER] = `${relative(process.cwd(), declaration.getSourceFile().fileName)}#${name}`;
		}
	}

	return schema;
}

function unionTypeToJsonSchema(type: ts.UnionType, checker: ts.TypeChecker, depth: number): JsonSchema {
	const members = type.types.map(t => tsTypeToJsonSchema(t, checker, depth + 1));

	const nullish = members.filter(m => m.type === 'null');
	const nonNullish = members.filter(m => m.type !== 'null');

	// boolean is represented as true | false union in TS
	if (nonNullish.length === 2 &&
		nonNullish.every(m => m.type === 'boolean' && m.enum)) {
		if (nullish.length > 0) {
			return { oneOf: [{ type: 'boolean' }, { type: 'null' }] };
		}
		return { type: 'boolean' };
	}

	// T | null → oneOf [T, null]
	if (nonNullish.length === 1 && nullish.length > 0) {
		return { oneOf: [nonNullish[0], { type: 'null' }] };
	}

	// All same base type with enum values
	const allEnums = nonNullish.every(m => m.enum);
	if (allEnums && nonNullish.length > 0) {
		const baseType = nonNullish[0].type;
		if (nonNullish.every(m => m.type === baseType)) {
			const enumValues = nonNullish.flatMap(m => m.enum || []);
			const schema: JsonSchema = { type: baseType, enum: enumValues };
			if (nullish.length > 0) {
				return { oneOf: [schema, { type: 'null' }] };
			}
			return schema;
		}
	}

	// General union → oneOf
	if (nonNullish.length > 1) {
		const allMembers = nullish.length > 0 ? [...nonNullish, { type: 'null' }] : nonNullish;
		return { oneOf: allMembers };
	}

	return members[0] || { type: 'unknown' };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Unwrap Promise<T> → T. If the type is not a Promise, returns it unchanged.
 */
function unwrapPromise(type: ts.Type, checker: ts.TypeChecker): ts.Type {
	// Check if it's a Promise by looking at the symbol name
	const symbol = type.getSymbol();
	if (symbol && symbol.getName() === 'Promise') {
		const typeArgs = (type as ts.TypeReference).typeArguments;
		if (typeArgs && typeArgs.length === 1) {
			return typeArgs[0];
		}
	}
	return type;
}

// ── AST-only fallback (for explicit type annotations without checker) ───────

function typeNodeToJsonSchema(typeNode: ts.TypeNode, sourceFile: ts.SourceFile): JsonSchema {
	if (ts.isToken(typeNode)) {
		switch (typeNode.kind) {
			case ts.SyntaxKind.StringKeyword: return { type: 'string' };
			case ts.SyntaxKind.NumberKeyword: return { type: 'number' };
			case ts.SyntaxKind.BooleanKeyword: return { type: 'boolean' };
			case ts.SyntaxKind.NullKeyword: return { type: 'null' };
			case ts.SyntaxKind.VoidKeyword: return { type: 'null' };
			case ts.SyntaxKind.AnyKeyword: return {};
			default: return { type: 'unknown' };
		}
	}

	if (ts.isTypeLiteralNode(typeNode)) {
		const properties: Record<string, JsonSchema> = {};
		const required: string[] = [];
		for (const member of typeNode.members) {
			if (ts.isPropertySignature(member) && member.name) {
				const propName = member.name.getText(sourceFile);
				properties[propName] = member.type ? typeNodeToJsonSchema(member.type, sourceFile) : { type: 'unknown' };
				if (!member.questionToken) required.push(propName);
			}
		}
		const schema: JsonSchema = { type: 'object', properties };
		if (required.length > 0) schema.required = required;
		return schema;
	}

	if (ts.isArrayTypeNode(typeNode)) {
		return { type: 'array', items: typeNodeToJsonSchema(typeNode.elementType, sourceFile) };
	}

	return { type: 'unknown' };
}
