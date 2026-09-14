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
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';

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
}

/**
 * Public so `generate-spec.ts` and any future emitter can share the same
 * vocabulary. Spelt as a single token to avoid hyphenation surprises in
 * JSDoc parsers.
 */
export const BLOCKS_SKIP_CODEGEN_TAG = 'blocksSkipCodegen';

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
				const handler = node.arguments[node.arguments.length - 1];
				const nsName = enclosingBindingName(node);
				if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) {
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
	let checker: ts.TypeChecker;
	let sourceFile: ts.SourceFile | undefined;

	if (configPath) {
		const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
		const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath));
		// Only include our target file — the compiler resolves imports on demand.
		// This is much faster than passing the full fileNames list from tsconfig.
		const options = { ...parsed.options, skipLibCheck: true, skipDefaultLibCheck: true };
		program = ts.createProgram([absPath], options);
	} else {
		// No tsconfig — create a minimal program
		program = ts.createProgram([absPath], {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			strict: true,
			esModuleInterop: true,
			skipLibCheck: true,
		});
	}

	checker = program.getTypeChecker();
	sourceFile = program.getSourceFile(absPath);
	if (!sourceFile) return result;

	// Find new ApiNamespace(scope, name, handler) and extract methods using the type checker
	ts.forEachChild(sourceFile, function visit(node) {
		if (ts.isNewExpression(node)) {
			const fnName = node.expression;
			if (ts.isIdentifier(fnName) && fnName.text === 'ApiNamespace' && node.arguments && node.arguments.length >= 2) {
				const handlerArg = node.arguments[node.arguments.length - 1];
				extractMethodsFromHandler(handlerArg, checker, sourceFile!, result, enclosingBindingName(node));
			}
		}
		ts.forEachChild(node, visit);
	});

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

			// (b) Object binding pattern: `const { indirectNamespace } = factory()`.
			// Each destructured binding is a separate namespace whose name is the
			// LOCAL binding name (the name it's exported under). Resolve the property
			// type off the initializer and extract methods keyed by that name, so a
			// factory-returned namespace keys qualified (`indirectNamespace.method`)
			// like a directly-constructed one — instead of landing on a bare key that
			// collides with same-named methods in other namespaces (#444, #445).
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
			// attribute (default exports, deeper indirection, the patterns below), so
			// it is NOT redundant.
			//
			// Boundary: only a top-level identifier (a) and a shallow object binding
			// pattern (b) are attributed. Array patterns (`const [ns] = factory()`)
			// and nested patterns (`const { a: { b } } = …`) fall through to the
			// bare-key path, where the #498 fallback still resolves the schema when
			// there's no collision. These shapes are rare for namespace exports and
			// fail soft; widening the traversal can come later if a real case appears.
			if (ts.isObjectBindingPattern(decl.name)) {
				const initType = checker.getTypeAtLocation(decl.initializer);
				for (const element of decl.name.elements) {
					if (!ts.isIdentifier(element.name)) continue;
					const localName = element.name.text;
					// `const { foo: bar } = …` binds `bar` but reads property `foo`.
					const propKey = element.propertyName && ts.isIdentifier(element.propertyName)
						? element.propertyName.text
						: localName;
					const propSymbol = initType.getProperty(propKey);
					if (!propSymbol) continue;
					const propType = checker.getTypeOfSymbol(propSymbol);
					extractMethodsFromResolvedType(propType, checker, result, localName);
				}
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
			const info = extractMethodTypeInfo(prop, checker, sourceFile);
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
		if (symbol) {
			const paramType = checker.getTypeOfSymbolAtLocation(symbol, param);
			schema = tsTypeToJsonSchema(paramType, checker);
		} else if (param.type) {
			// Fallback to AST-based extraction
			schema = typeNodeToJsonSchema(param.type, sourceFile);
		}
		params.push({ name, required, schema });
	}

	// Return type: use the type checker to get the inferred return type
	let returnType: JsonSchema = { type: 'unknown' };
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
		returnType = tsTypeToJsonSchema(retType, checker);
	}

	const skipCodegen = hasBlocksSkipCodegenTag(method) || undefined;
	return { params, returnType, transferable, skipCodegen };
}

/**
 * Walk a return-type AST node, unwrapping a single layer of `Promise<T>`,
 * and return the inner `TypeReferenceNode` if any. Used to recover the
 * syntactic type-arguments the customer wrote — `Promise<RealtimeChannel>`
 * has no inner `<...>`, while `Promise<RealtimeChannel<X>>` does.
 */
function unwrapPromiseTypeNode(node: ts.TypeNode | undefined): ts.TypeReferenceNode | undefined {
	if (!node || !ts.isTypeReferenceNode(node)) return undefined;
	const name = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.getText();
	if (name === 'Promise' && node.typeArguments && node.typeArguments.length === 1) {
		const inner = node.typeArguments[0];
		return ts.isTypeReferenceNode(inner) ? inner : undefined;
	}
	return node;
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

	let methodsType = type;

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

		const propType = checker.getTypeOfSymbol(prop);
		const methodSigs = propType.getCallSignatures();
		if (methodSigs.length === 0) continue;

		const sig = methodSigs[0];

		// Extract params
		const params: ParamTypeInfo[] = [];
		for (const paramSymbol of sig.getParameters()) {
			const paramType = checker.getTypeOfSymbol(paramSymbol);
			const schema = tsTypeToJsonSchema(paramType, checker);
			const paramDecl = paramSymbol.valueDeclaration;
			const isOptional = paramDecl && ts.isParameter(paramDecl)
				? !!(paramDecl.questionToken || paramDecl.initializer)
				: (paramSymbol.flags & ts.SymbolFlags.Optional) !== 0;
			params.push({
				name: paramSymbol.getName(),
				required: !isOptional,
				schema,
			});
		}

		// Extract return type (unwrap Promise<T>)
		let retType = checker.getReturnTypeOfSignature(sig);
		retType = unwrapPromise(retType, checker);
		// Check if the return type is a transferable before converting to schema
		const transferable = detectTransferable(retType, checker);
		const returnType = tsTypeToJsonSchema(retType, checker);

		// JSDoc lives on the original method declaration, which we can reach
		// via the symbol's `valueDeclaration` (the `MethodDeclaration` node in
		// the BB-helper file that minted the AsyncAPI<T> shape).
		let skipCodegen: true | undefined;
		const declaration = prop.valueDeclaration;
		if (declaration && hasBlocksSkipCodegenTag(declaration)) {
			skipCodegen = true;
		}

		result.set(key, { params, returnType, transferable, skipCodegen });
	}
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
	// by the checker shouldn't appear in the spec).
	const typeArgs: JsonSchema[] = [];
	const wroteTypeArgs = syntacticNode?.typeArguments && syntacticNode.typeArguments.length > 0;
	if (wroteTypeArgs) {
		const typeRef = type as ts.TypeReference;
		const resolvedArgs = typeRef.typeArguments ?? [];
		for (const arg of resolvedArgs) {
			// Explicit `unknown` / `any` → empty schema (matches Req 4.3).
			const argFlags = arg.getFlags();
			if (argFlags & ts.TypeFlags.Unknown || argFlags & ts.TypeFlags.Any) {
				typeArgs.push({});
			} else {
				typeArgs.push(tsTypeToJsonSchema(arg, checker));
			}
		}
	}

	return { blocksTag, typeArgs };
}

// ── ts.Type → JSON Schema conversion ────────────────────────────────────────

/** Recursion guard to prevent infinite loops on recursive types. */
const MAX_DEPTH = 6;

/**
 * Convert a resolved `ts.Type` to JSON Schema.
 * This handles inferred types, imported types, type aliases, etc.
 */
function tsTypeToJsonSchema(type: ts.Type, checker: ts.TypeChecker, depth = 0): JsonSchema {
	if (depth > MAX_DEPTH) return { type: 'object' };

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

		return objectTypeToJsonSchema(type as ts.ObjectType, checker, depth);
	}

	return { type: 'unknown' };
}

function objectTypeToJsonSchema(type: ts.ObjectType, checker: ts.TypeChecker, depth: number): JsonSchema {
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
		const propSchema = tsTypeToJsonSchema(propType, checker, depth + 1);
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
	const symbol = type.getSymbol() || type.aliasSymbol;
	if (symbol) {
		const name = symbol.getName();
		// Skip anonymous/synthetic names
		if (name && name !== '__type' && name !== '__object' && !name.startsWith('__')) {
			schema.title = name;
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
