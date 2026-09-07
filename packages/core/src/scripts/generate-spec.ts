// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate an OpenRPC 1.3.2 specification document from backend ApiNamespace exports.
 *
 * Phase 1: Introspect each `ApiNamespace`, discover methods, emit base types.
 * Phase 2: Detect Zod schemas referenced in method bodies and emit precise
 *          JSON Schema types via Zod 4's built-in `toJSONSchema()`.
 *
 * The mechanism mirrors `generate-client.ts`: dynamically import the backend
 * via `pathToFileURL`, discover `ApiNamespace` exports via `API_NAMESPACE_MARKER`,
 * and reflect on handler methods.
 *
 * @see docs/native-clients/codegen-design.md — IR design decision and authoring progression
 * @see docs/native-clients/schema-generation-guide-for-devs.md — customer-facing guide and `x-blocks-*` reference
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { API_NAMESPACE_MARKER } from '../api.js';
import { extractMethodTypes, extractSkipCodegenMethods, type MethodTypeInfo } from './extract-ts-types.js';
import { validateSpec, type SpecValidationError } from './validate-spec.js';

// ── OpenRPC types (subset) ──────────────────────────────────────────────────

interface OpenRpcDocument {
	openrpc: string;
	info: { title: string; version: string };
	servers?: { name: string; url: string }[];
	methods: OpenRpcMethod[];
	components?: { schemas?: Record<string, JsonSchema> };
}

interface OpenRpcMethod {
	name: string;
	params: OpenRpcParam[];
	result: OpenRpcResult;
}

interface OpenRpcParam {
	name: string;
	required: boolean;
	schema: JsonSchema;
}

interface OpenRpcResult {
	name: string;
	schema: JsonSchema;
}

interface JsonSchema {
	type?: string;
	$ref?: string;
	[key: string]: unknown;
}

// ── Zod detection ───────────────────────────────────────────────────────────

/**
 * Check if a value is a Zod schema (Zod 4+).
 * Zod 4 schemas have a `_zod` property with `def`, `parse`, etc.
 */
function isZodSchema(val: unknown): boolean {
	return val != null && typeof val === 'object' && (val as any)._zod != null && typeof (val as any)._zod === 'object';
}

/**
 * Try to convert a Zod schema to JSON Schema using Zod 4's built-in `toJSONSchema()`.
 * Returns null if the conversion fails or Zod is not available.
 */
function zodToJsonSchema(zodModule: any, schema: unknown): JsonSchema | null {
	try {
		if (typeof zodModule?.toJSONSchema !== 'function') return null;
		const raw = zodModule.toJSONSchema(schema);
		// Strip the $schema field — OpenRPC components don't need it
		const { $schema, ...rest } = raw;
		return rest as JsonSchema;
	} catch {
		return null;
	}
}

/**
 * Extract the meta `id` from a Zod schema's JSON Schema output.
 * Zod 4's `.meta({ id: 'Post' })` emits `"id": "Post"` at the top level.
 */
function getSchemaMetaId(jsonSchema: JsonSchema): string | undefined {
	const id = jsonSchema.id;
	if (typeof id === 'string' && id.length > 0) return id;
	return undefined;
}

/** Capitalize first letter: "kvGet" → "KvGet" */
function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Collect all Zod schemas reachable from the backend module.
 *
 * Walks exported values looking for anything with `_zod`. Also walks
 * one level into plain objects (e.g., an exported `schemas` map).
 * Returns a map of variable-name → Zod schema instance.
 */
function collectZodSchemas(backend: Record<string, any>): Map<string, unknown> {
	const schemas = new Map<string, unknown>();
	for (const [name, value] of Object.entries(backend)) {
		if (name.startsWith('_')) continue;
		if (isZodSchema(value)) {
			schemas.set(name, value);
		} else if (value != null && typeof value === 'object' && !Array.isArray(value)) {
			// Walk one level into plain objects (e.g., exported schema maps)
			for (const [subName, subValue] of Object.entries(value)) {
				if (isZodSchema(subValue)) {
					schemas.set(subName, subValue);
				}
			}
		}
	}
	return schemas;
}

/**
 * Scan a function's source text for `.parse(` calls that reference known
 * Zod schema variable names. Returns the first matching schema, or null.
 *
 * Matches patterns like:
 * - `GetPostInput.parse(rawInput)`
 * - `GetPostInput.safeParse(rawInput)`
 * - `schema.parse(input)`
 */
function findZodParseSchema(
	fnSource: string,
	knownSchemas: Map<string, unknown>,
): unknown | null {
	for (const [name] of knownSchemas) {
		// Match: schemaName.parse( or schemaName.safeParse(
		const pattern = new RegExp(`\\b${escapeRegex(name)}\\s*\\.\\s*(?:safe)?[Pp]arse\\s*\\(`);
		if (pattern.test(fnSource)) {
			return knownSchemas.get(name) ?? null;
		}
	}
	return null;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Param name extraction ───────────────────────────────────────────────────

/**
 * Extract parameter names from a function using `Function.toString()`.
 *
 * Handles:
 * - `async foo(a, b, c) { ... }`
 * - `async (a, b) => { ... }`
 * - `function foo(a, b) { ... }`
 * - Destructured params: `{ key, value }` → single param named `param0`
 * - Default values: `a = 5` → `a`
 * - Rest params: `...args` → `args`
 * - Optional params: `a?` → `a` (TS syntax erased, but sometimes visible)
 */
function extractParamNames(fn: Function): string[] {
	const src = fn.toString();

	// Match the parameter list between the first ( and its matching )
	const openParen = src.indexOf('(');
	if (openParen === -1) return [];

	// Find matching close paren, accounting for nested parens
	let depth = 0;
	let closeParen = -1;
	for (let i = openParen; i < src.length; i++) {
		if (src[i] === '(') depth++;
		else if (src[i] === ')') {
			depth--;
			if (depth === 0) { closeParen = i; break; }
		}
	}
	if (closeParen === -1) return [];

	const paramStr = src.substring(openParen + 1, closeParen).trim();
	if (!paramStr) return [];

	// Split on commas, but respect nested braces/brackets/parens
	const params: string[] = [];
	let current = '';
	let nestDepth = 0;
	for (const ch of paramStr) {
		if (ch === '(' || ch === '{' || ch === '[') nestDepth++;
		else if (ch === ')' || ch === '}' || ch === ']') nestDepth--;
		else if (ch === ',' && nestDepth === 0) {
			params.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.trim()) params.push(current.trim());

	return params.map((raw, i) => {
		// Destructured: { key, value } → param{i}
		if (raw.startsWith('{') || raw.startsWith('[')) return `param${i}`;
		// Rest: ...args → args
		if (raw.startsWith('...')) raw = raw.slice(3);
		// Strip default value: a = 5 → a
		const eqIdx = raw.indexOf('=');
		if (eqIdx !== -1) raw = raw.substring(0, eqIdx);
		// Strip TS type annotation: a: string → a  (visible in some runtimes)
		const colonIdx = raw.indexOf(':');
		if (colonIdx !== -1) raw = raw.substring(0, colonIdx);
		// Strip optional marker: a? → a
		raw = raw.replace(/\?$/, '');
		return raw.trim();
	});
}

// ── Spec generation ─────────────────────────────────────────────────────────

/**
 * Discover all `ApiNamespace` exports from the backend module and build
 * an OpenRPC document describing every method.
 *
 * For methods that reference Zod schemas (detected via `.parse()` calls in
 * the function body), emits precise JSON Schema types. For plain TS methods,
 * falls back to `{ "type": "unknown" }`.
 *
 * Named schemas (via `.meta({ id: 'Post' })`) are placed in
 * `components.schemas` with `$ref` pointers. Unnamed schemas are inlined
 * or given synthetic names like `KvGetInput`.
 */
/**
 * Loader for the foundation module. Defaults to plain dynamic `import()` so JS
 * entry points work with no extra deps. The CLI overrides this with a tsx-based
 * loader when the entry point ends in `.ts` / `.tsx`, so customers can point the
 * spec emitter at their TypeScript source without an extra build step.
 */
export type FoundationLoader = (fileUrl: string) => Promise<Record<string, unknown>>;

const defaultLoader: FoundationLoader = (url) => import(url);

export async function generateSpec(
	foundationPath: string,
	loader: FoundationLoader = defaultLoader,
): Promise<OpenRpcDocument> {
	// Reuse the same global-collector pattern as generate-client.ts so that
	// Building Block constructors don't fail during import.
	const collectorAlreadyActive = Array.isArray((globalThis as any).__BLOCKS_CLIENT_MIDDLEWARE__);
	if (!collectorAlreadyActive) {
		(globalThis as any).__BLOCKS_CLIENT_MIDDLEWARE__ = [];
	}

	const backend = await loader(pathToFileURL(foundationPath).href);

	if (!collectorAlreadyActive) {
		delete (globalThis as any).__BLOCKS_CLIENT_MIDDLEWARE__;
	}

	// Try to import Zod from the backend's dependency tree.
	// If Zod isn't installed, Phase 2 features are skipped gracefully.
	let zodModule: any = null;
	try {
		zodModule = await import('zod');
		// Zod 4 re-exports from a nested module; normalize
		if (zodModule.z && typeof zodModule.z.toJSONSchema === 'function') {
			zodModule = zodModule.z;
		}
	} catch {
		// Zod not available — all schemas will be { type: "unknown" }
	}

	// Collect Zod schemas from module exports
	const knownSchemas = collectZodSchemas(backend);

	// Extract TypeScript type info from the source file (AST-based).
	// Used as fallback for methods without Zod schemas — gives base types
	// (string, number, boolean, object shapes) instead of "unknown".
	let tsTypes = new Map<string, MethodTypeInfo>();
	try {
		tsTypes = extractMethodTypes(foundationPath);
	} catch {
		// TS parsing failed — fall back to unknown types
	}

	// Pure-AST scan for `@blocksSkipCodegen`-tagged methods. Runs even when
	// `extractMethodTypes` blows up on a real-world TS program (a common
	// scenario: missing tsconfig paths, third-party `.d.ts` mismatches).
	let skipCodegenNames = new Set<string>();
	try {
		skipCodegenNames = extractSkipCodegenMethods(foundationPath);
	} catch {
		// AST parse failed — nothing to skip.
	}

	const methods: OpenRpcMethod[] = [];
	const componentSchemas: Record<string, JsonSchema> = {};

	for (const [exportName, exportValue] of Object.entries(backend)) {
		if (exportName.startsWith('_')) continue;

		const namespaceName = (exportValue as any)?.[API_NAMESPACE_MARKER];
		if (typeof namespaceName !== 'string') continue;

		// Use the export name for the qualified method name — this matches
		// how the dev server and Lambda handler register APIs (by export name,
		// not the ApiNamespace() first argument).
		const routingName = exportName;

		// ApiNamespace is a function (context) => { method1, method2, ... }
		// Call it with a stub context to get the method map.
		const stubContext = createStubContext();
		let methodMap: Record<string, Function>;
		try {
			const result = typeof exportValue === 'function' ? exportValue(stubContext) : exportValue;
			methodMap = result && typeof result === 'object' ? result : {};
		} catch {
			// If the handler throws during stub invocation, skip this namespace
			continue;
		}

		for (const [methodName, methodFn] of Object.entries(methodMap)) {
			if (typeof methodFn !== 'function') continue;

			const qualifiedName = `${routingName}.${methodName}`;
			// Prefer the namespace-qualified TS types; fall back to the bare method
			// name for entries the extractor couldn't attribute to a namespace.
			// Qualified keys stop two namespaces that share a method name (e.g.
			// widgets.create / subscriptions.create) from cross-assigning schemas.
			const tsInfo = tsTypes.get(qualifiedName) ?? tsTypes.get(methodName);

			// `@blocksSkipCodegen` is a JSDoc tag the customer puts on a method
			// they want callable from the generated TS client (Proxy-based,
			// doesn't enumerate) but absent from the OpenRPC spec — so native
			// generators (Swift / Kotlin) never emit a binding for it.
			// Mock-only / dev-only helpers like `getLastCode` use this.
			//
			// Two sources because `extractMethodTypes` can fail-soft on
			// type-resolution errors and silently empty its Map — we always
			// want the JSDoc tag to be honored, so the AST-only scan acts as
			// a safety net.
			if (tsInfo?.skipCodegen || skipCodegenNames.has(methodName)) continue;

			const resultName = capitalize(methodName) + 'Result';
			const paramNames = extractParamNames(methodFn);
			const fnSource = methodFn.toString();

			// Phase 2: try to find a Zod input schema referenced in the method body
			const inputSchema = zodModule ? findZodParseSchema(fnSource, knownSchemas) : null;
			let inputJsonSchema: JsonSchema | null = null;

			if (inputSchema && zodModule) {
				inputJsonSchema = zodToJsonSchema(zodModule, inputSchema);
			}

			let params: OpenRpcParam[];

			if (inputJsonSchema && inputJsonSchema.type === 'object' && inputJsonSchema.properties) {
				// Zod object schema detected — emit one param per property
				const required = new Set<string>(
					Array.isArray(inputJsonSchema.required) ? inputJsonSchema.required as string[] : []
				);
				const metaId = getSchemaMetaId(inputJsonSchema);

				if (metaId) {
					// Named schema → place in components.schemas, reference via $ref
					const { id: _id, additionalProperties: _ap, ...cleanSchema } = inputJsonSchema;
					componentSchemas[metaId] = cleanSchema;
				}

				params = Object.entries(inputJsonSchema.properties as Record<string, JsonSchema>).map(
					([propName, propSchema]) => ({
						name: propName,
						required: required.has(propName),
						schema: cleanJsonSchema(propSchema),
					})
				);
			} else if (inputJsonSchema) {
				// Non-object Zod schema (e.g., z.string()) — single param
				params = paramNames.map((name) => ({
					name,
					required: true,
					schema: cleanJsonSchema(inputJsonSchema!),
				}));
			} else {
				// No Zod schema — fall back to TypeScript AST types
				if (tsInfo) {
					params = tsInfo.params.map((p) => ({
						name: p.name,
						required: p.required,
						schema: p.schema.type === 'unknown' ? { type: 'unknown' } : p.schema,
					}));
				} else {
					// No TS type info either — emit unknown
					params = paramNames.map((name) => ({
						name,
						required: true,
						schema: { type: 'unknown' },
					}));
				}
			}

			// Return type: Zod doesn't cover this yet, so use TS types (tsInfo resolved above)
			const rawResultSchema = tsInfo?.returnType && tsInfo.returnType.type !== 'unknown'
				? tsInfo.returnType
				: { type: 'unknown' };

			// Determine result schema — transferable types get semantic annotations
			let resultSchema: JsonSchema;

			if (tsInfo?.transferable) {
				// Emit x-blocks-transferable instead of raw object schema
				const transferableSchema: JsonSchema = {
					'x-blocks-transferable': tsInfo.transferable.blocksTag,
				};
				if (tsInfo.transferable.typeArgs.length > 0) {
					// Hoist named type args to components.schemas, build the type-args array
					const typeArgsSchemas: JsonSchema[] = [];
					for (const argSchema of tsInfo.transferable.typeArgs) {
						const argTitle = argSchema.title as string | undefined;
						if (argTitle && argSchema.type === 'object' && argSchema.properties) {
							const { title: _t, ...cleanArg } = argSchema;
							if (!componentSchemas[argTitle]) {
								componentSchemas[argTitle] = cleanArg;
							}
							typeArgsSchemas.push({ $ref: `#/components/schemas/${argTitle}` });
						} else {
							typeArgsSchemas.push(argSchema);
						}
					}
					transferableSchema['x-blocks-type-args'] = typeArgsSchemas;
				}
				resultSchema = transferableSchema;
			} else if (rawResultSchema.title && rawResultSchema.type === 'object' && rawResultSchema.properties) {
				// Named object type → extract to components.schemas
				const returnTitle = rawResultSchema.title as string;
				const { title: _t, ...cleanReturn } = rawResultSchema;
				if (!componentSchemas[returnTitle]) {
					componentSchemas[returnTitle] = cleanReturn;
				}
				resultSchema = { $ref: `#/components/schemas/${returnTitle}` };
			} else if (rawResultSchema.type === 'array' && rawResultSchema.items) {
				// Check if array items have a named type (e.g., Todo[] → extract Todo)
				const items = rawResultSchema.items as JsonSchema;
				const itemsTitle = items.title as string | undefined;
				if (itemsTitle && items.type === 'object' && items.properties) {
					const { title: _t, ...cleanItems } = items;
					if (!componentSchemas[itemsTitle]) {
						componentSchemas[itemsTitle] = cleanItems;
					}
					resultSchema = { type: 'array', items: { $ref: `#/components/schemas/${itemsTitle}` } };
				} else {
					resultSchema = rawResultSchema;
				}
			} else {
				resultSchema = rawResultSchema;
			}

			methods.push({
				name: qualifiedName,
				params,
				result: {
					name: resultName,
					schema: resultSchema,
				},
			});
		}
	}

	// Sort methods alphabetically for stable output
	methods.sort((a, b) => a.name.localeCompare(b.name));

	// Post-process step 1: regroup nested-union arms that share a primary
	// discriminator. Run BEFORE hoisting so the regrouped wrapper picks up
	// the named title (if any) in one go and codegen sees a single arm per
	// action name.
	for (const method of methods) {
		for (const param of method.params) {
			param.schema = regroupSharedDiscriminator(param.schema);
		}
		method.result.schema = regroupSharedDiscriminator(method.result.schema);
	}
	for (const [name, schema] of Object.entries(componentSchemas)) {
		componentSchemas[name] = regroupSharedDiscriminator(schema);
	}

	// Post-process step 2: walk all schemas and hoist named types (objects with `title`)
	// to components.schemas with $ref pointers. This catches named types nested
	// inside other schemas (e.g., AuthUser inside AuthState.user oneOf).
	for (const method of methods) {
		for (const param of method.params) {
			param.schema = hoistNamedSchemas(param.schema, componentSchemas);
		}
		method.result.schema = hoistNamedSchemas(method.result.schema, componentSchemas);
	}
	// Also walk component schemas themselves (e.g., AuthState contains AuthAction contains AuthField)
	for (const [name, schema] of Object.entries(componentSchemas)) {
		componentSchemas[name] = hoistNamedSchemas(schema, componentSchemas, name);
	}

	const doc: OpenRpcDocument = {
		openrpc: '1.3.2',
		info: { title: 'api', version: '1.0.0' },
		methods,
	};

	if (Object.keys(componentSchemas).length > 0) {
		doc.components = { schemas: componentSchemas };
	}

	return doc;
}

/**
 * Recursively walk a JSON Schema tree and hoist any named object types
 * (those with a `title` property) to `componentSchemas` with `$ref` pointers.
 *
 * This ensures types like `AuthUser` (nested inside `AuthState.user`) get
 * extracted to `components.schemas` so native codegen produces named types
 * instead of anonymous inline structs.
 *
 * @param skipTitle - Don't hoist the schema itself if its title matches this
 *   (prevents a component schema from replacing itself with a self-$ref).
 */
function hoistNamedSchemas(
	schema: JsonSchema,
	componentSchemas: Record<string, JsonSchema>,
	skipTitle?: string,
): JsonSchema {
	if (!schema || typeof schema !== 'object') return schema;

	// If this is a $ref, nothing to do
	if (schema.$ref) return schema;

	// If this is a named object type, hoist it (unless it's the schema we're currently inside
	// or it's a built-in JS type that shouldn't become a component schema)
	const BUILTIN_TYPES = new Set(['Date', 'RegExp', 'Error', 'Map', 'Set', 'Promise', 'ArrayBuffer', 'URL']);
	const title = schema.title as string | undefined;
	if (title && title !== skipTitle && !BUILTIN_TYPES.has(title) && schema.type === 'object' && schema.properties) {
		const { title: _t, ...cleanSchema } = schema as any;
		if (!componentSchemas[title]) {
			componentSchemas[title] = cleanSchema;
			// Recursively hoist within the newly added schema
			componentSchemas[title] = hoistNamedSchemas(cleanSchema, componentSchemas, title);
		}
		return { $ref: `#/components/schemas/${title}` };
	}

	// Walk properties
	if (schema.properties) {
		const newProps: Record<string, JsonSchema> = {};
		for (const [key, val] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
			newProps[key] = hoistNamedSchemas(val, componentSchemas, skipTitle);
		}
		schema = { ...schema, properties: newProps };
	}

	// Walk array items
	if (schema.items) {
		if (Array.isArray(schema.items)) {
			schema = { ...schema, items: schema.items.map((i: JsonSchema) => hoistNamedSchemas(i, componentSchemas, skipTitle)) };
		} else {
			schema = { ...schema, items: hoistNamedSchemas(schema.items as JsonSchema, componentSchemas, skipTitle) };
		}
	}

	// Walk oneOf
	if (Array.isArray(schema.oneOf)) {
		schema = { ...schema, oneOf: schema.oneOf.map((s: JsonSchema) => hoistNamedSchemas(s, componentSchemas, skipTitle)) };
	}

	// Walk additionalProperties
	if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
		schema = { ...schema, additionalProperties: hoistNamedSchemas(schema.additionalProperties as JsonSchema, componentSchemas, skipTitle) };
	}

	return schema;
}

/**
 * Strip Zod-generated noise from a schema for cleaner OpenRPC output.
 * Removes `$schema` and `id` (meta) fields. Preserves
 * `additionalProperties` because it carries open-shape semantics for
 * intersections like `T & Record<string, V>` (e.g. Cognito sign-up's
 * custom-attribute payload) that consumer codegen needs to honor.
 */
function cleanJsonSchema(schema: JsonSchema): JsonSchema {
	const { $schema, id, ...rest } = schema;
	return rest;
}

/**
 * If a `oneOf` arose from the TS pattern `{ action: K } & U[K]` where `U[K]`
 * is itself a union (e.g. Cognito's `confirmSignIn` challenge variants),
 * the intersection distributes — producing N flat sibling arms that all
 * share a primary discriminator (`action: 'confirmSignIn'`) plus a few
 * shared base fields. Native codegen sees N look-alike structs and falls
 * back to numeric suffixes (`ConfirmSignIn_1`, `ConfirmSignIn_2`, …).
 *
 * This pass walks each `oneOf` and, for any group of arms whose primary
 * discriminator collapses to the same single literal value, regroups them
 * under one outer arm with a nested `oneOf` over the remaining
 * (truly-distinguishing) per-arm fields. A secondary discriminator field —
 * one whose literal value differs across the group — is kept per-arm so
 * the inner `oneOf` stays a discriminated union.
 */
function regroupSharedDiscriminator(schema: JsonSchema): JsonSchema {
	if (!schema || typeof schema !== 'object') return schema;

	// Recurse first so nested oneOfs are normalized bottom-up.
	if (schema.properties) {
		const newProps: Record<string, JsonSchema> = {};
		for (const [k, v] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
			newProps[k] = regroupSharedDiscriminator(v);
		}
		schema = { ...schema, properties: newProps };
	}
	if (schema.items) {
		if (Array.isArray(schema.items)) {
			schema = { ...schema, items: schema.items.map((s: JsonSchema) => regroupSharedDiscriminator(s)) };
		} else {
			schema = { ...schema, items: regroupSharedDiscriminator(schema.items as JsonSchema) };
		}
	}
	if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
		schema = { ...schema, additionalProperties: regroupSharedDiscriminator(schema.additionalProperties as JsonSchema) };
	}

	if (!Array.isArray(schema.oneOf)) return schema;

	const arms = (schema.oneOf as JsonSchema[]).map((a) => regroupSharedDiscriminator(a));

	// Group arms by their primary discriminator literal value. We pick the
	// discriminator as the field that has a single-literal `const`/`enum`
	// value AND appears with the same literal across every member of a
	// candidate group. Fall back: most-common-literal field name.
	const primary = findPrimaryDiscriminator(arms);
	if (!primary) return { ...schema, oneOf: arms };

	const groups = new Map<string, JsonSchema[]>();
	const ungrouped: JsonSchema[] = [];
	for (const arm of arms) {
		const lit = singleLiteralValue(arm, primary);
		if (lit === undefined) {
			ungrouped.push(arm);
			continue;
		}
		const list = groups.get(lit) ?? [];
		list.push(arm);
		groups.set(lit, list);
	}

	const out: JsonSchema[] = [...ungrouped];
	for (const [literal, members] of groups) {
		if (members.length < 2) {
			out.push(...members);
			continue;
		}
		// Compute fields shared across every member with the same shape
		// (same single-literal value or same schema). Any field whose
		// single-literal value DIFFERS across members must stay per-arm.
		const sharedFieldNames = new Set<string>(sharedRequiredProperties(members));
		// Drop fields that have differing single-literals — those are the
		// secondary discriminator and must remain on each inner arm.
		for (const name of [...sharedFieldNames]) {
			const valuesAcrossGroup = new Set<string>();
			let hasNonLiteral = false;
			for (const m of members) {
				const v = singleLiteralValue(m, name);
				if (v === undefined) {
					hasNonLiteral = true;
					break;
				}
				valuesAcrossGroup.add(v);
			}
			if (hasNonLiteral) continue;
			if (valuesAcrossGroup.size > 1) sharedFieldNames.delete(name);
		}

		const sharedProps: Record<string, JsonSchema> = {};
		const sharedRequired: string[] = [];
		const memberProps0 = (members[0]!.properties as Record<string, JsonSchema> | undefined) ?? {};
		const memberRequired0 = (members[0]!.required as string[] | undefined) ?? [];
		for (const name of sharedFieldNames) {
			if (memberProps0[name]) sharedProps[name] = memberProps0[name]!;
			if (memberRequired0.includes(name)) sharedRequired.push(name);
		}

		// Each inner arm gets the per-arm subset (everything not in shared).
		const innerArms: JsonSchema[] = members.map((m) => {
			const props = (m.properties as Record<string, JsonSchema> | undefined) ?? {};
			const req = (m.required as string[] | undefined) ?? [];
			const innerProps: Record<string, JsonSchema> = {};
			const innerReq: string[] = [];
			for (const [k, v] of Object.entries(props)) {
				if (sharedFieldNames.has(k)) continue;
				innerProps[k] = v;
				if (req.includes(k)) innerReq.push(k);
			}
			const inner: JsonSchema = { type: 'object', properties: innerProps };
			if (innerReq.length > 0) inner.required = innerReq;
			return inner;
		});

		const grouped: JsonSchema = {
			type: 'object',
			properties: sharedProps,
			...(sharedRequired.length > 0 ? { required: sharedRequired } : {}),
			oneOf: innerArms,
		};
		// preserve any x-blocks-* annotations that were on each arm by
		// promoting the first member's (they all matched on the
		// primary discriminator literal anyway)
		const m0 = members[0]!;
		const annotationKeys = Object.keys(m0).filter((k) => k.startsWith('x-blocks-'));
		for (const ak of annotationKeys) (grouped as any)[ak] = (m0 as any)[ak];
		out.push(grouped);
	}

	const next: JsonSchema = { ...schema, oneOf: out };
	return next;
}

function findPrimaryDiscriminator(arms: JsonSchema[]): string | null {
	if (arms.length === 0) return null;
	const counts = new Map<string, Map<string, number>>();
	for (const arm of arms) {
		const props = (arm.properties as Record<string, JsonSchema> | undefined) ?? {};
		for (const [name, sub] of Object.entries(props)) {
			const lit = singleLiteralValueFromSchema(sub);
			if (lit === undefined) continue;
			let m = counts.get(name);
			if (!m) { m = new Map(); counts.set(name, m); }
			m.set(lit, (m.get(lit) ?? 0) + 1);
		}
	}
	let best: string | null = null;
	let bestScore = 0;
	for (const [name, valueCounts] of counts) {
		// score = max group size for this field (bigger collapses first)
		let maxGroup = 0;
		for (const c of valueCounts.values()) if (c > maxGroup) maxGroup = c;
		if (maxGroup > bestScore) { bestScore = maxGroup; best = name; }
	}
	return bestScore >= 2 ? best : null;
}

function singleLiteralValue(arm: JsonSchema, field: string): string | undefined {
	const props = (arm.properties as Record<string, JsonSchema> | undefined) ?? {};
	const sub = props[field];
	if (!sub) return undefined;
	return singleLiteralValueFromSchema(sub);
}

function singleLiteralValueFromSchema(sub: JsonSchema): string | undefined {
	if (typeof sub.const === 'string') return sub.const;
	if (Array.isArray(sub.enum) && sub.enum.length === 1 && typeof sub.enum[0] === 'string') {
		return sub.enum[0];
	}
	return undefined;
}

function sharedRequiredProperties(members: JsonSchema[]): string[] {
	if (members.length === 0) return [];
	const first = members[0]!;
	const firstProps = (first.properties as Record<string, JsonSchema> | undefined) ?? {};
	const candidate = new Set<string>(Object.keys(firstProps));
	for (let i = 1; i < members.length; i++) {
		const props = (members[i]!.properties as Record<string, JsonSchema> | undefined) ?? {};
		for (const name of [...candidate]) {
			if (!(name in props)) candidate.delete(name);
		}
	}
	return [...candidate];
}

/**
 * Generate the OpenRPC spec, validate it, and write it to disk as `blocks.spec.json`.
 * Logs validation warnings but does not fail — the spec is still written.
 */
export async function writeSpec(
	foundationPath: string,
	outputPath: string,
	loader?: FoundationLoader,
): Promise<void> {
	const doc = await generateSpec(foundationPath, loader);

	// Populate servers array from deployed config if available
	const projectRoot = dirname(dirname(foundationPath));
	const configPath = join(projectRoot, '.blocks-sandbox', 'config.json');
	if (existsSync(configPath)) {
		try {
			const config = JSON.parse(readFileSync(configPath, 'utf-8'));
			if (config.apiUrl) {
				doc.servers = [{ name: config.environment || 'default', url: config.apiUrl }];
			}
		} catch {}
	}

	// Validate conformance
	const errors = validateSpec(doc);
	if (errors.length > 0) {
		console.warn(`⚠️  OpenRPC spec has ${errors.length} conformance issue(s):`);
		for (const err of errors) {
			console.warn(`   ${err.path}: ${err.message}`);
		}
	}

	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, JSON.stringify(doc, null, '\t'));
}

// ── Stub context ────────────────────────────────────────────────────────────

/**
 * Create a minimal stub `BlocksContext` so that `ApiNamespace` handler functions
 * can be invoked for method discovery without a real HTTP request.
 */
function createStubContext() {
	const headers = new Headers();
	return {
		request: {
			headers,
			body: null,
			json: async () => ({}),
			text: async () => '',
			params: {},
		},
		response: {
			headers: new Headers(),
			status: 200,
			send: () => {},
		},
	};
}
