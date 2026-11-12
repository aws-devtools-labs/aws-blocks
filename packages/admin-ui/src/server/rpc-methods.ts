// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { ApiMethod, ApiMethodParam, DiscoveredBlock, RpcNamespace } from '../contract/v1.js';

/**
 * The RPC method catalogue: what the playground can call, and what it knows
 * about the shape of each call.
 *
 * Two sources, in a deliberate order of authority:
 *
 * 1. **Discovery** (`block-discovery.ts`) reads the app's own source and yields
 *    every `ApiNamespace` method with its REAL parameter names. This is the base
 *    and is never overridden — it is what the app actually declares today.
 * 2. **The OpenRPC spec** (`aws-blocks/blocks.spec.json`, emitted by the repo's
 *    own `blocks-generate-spec` from Zod schemas) adds parameter TYPES, which no
 *    amount of source scanning can supply. Most apps will never have run the
 *    generator, so its absence is the normal case, not a failure.
 *
 * The spec SUPPLEMENTS discovery and never replaces it. The two are unioned on
 * `namespace.method` with discovery as the base:
 *
 * - In the source, missing from the spec → still listed (`origin: 'source'`).
 *   This is the common case the moment a developer adds a method, and dropping
 *   it would make the playground look broken exactly while they iterate.
 * - In both → listed with types attached (`origin: 'source+spec'`). Discovery's
 *   parameter names and flags survive; enrichment is strictly additive.
 * - In the spec, missing from the source → still listed, flagged
 *   (`origin: 'spec-only'`), because it means the spec is stale rather than that
 *   the method is fake.
 *
 * A spec that cannot be parsed degrades to `'source-scan'` AND sets
 * `methodsError` naming the file and the problem: silently ignoring a spec
 * somebody deliberately generated would leave them wondering why it had no
 * effect.
 */

/** Where the generated spec lives, relative to the project root. */
export const SPEC_FILE_RELATIVE_PATH = join('aws-blocks', 'blocks.spec.json');

/** The block type whose methods are callable over JSON-RPC. */
export const API_NAMESPACE_BLOCK_TYPE = 'ApiNamespace';

/**
 * What a seed value is, in one sentence the UI can render verbatim.
 *
 * Seeds are starting points derived from the schema so a form has something
 * type-correct in it. They are NOT defaults: the API applies nothing of the
 * kind, and a seed presented as a default would misrepresent the contract.
 */
export const SEED_NOTICE =
	'Seed values are starting points derived from the schema, not defaults the API applies. Replace them before calling.';

/** A JSON Schema fragment, exactly as the spec carries it. */
export type JsonSchema = Record<string, unknown>;

/**
 * Where a seed came from:
 * - `enum`: the schema's first enum member
 * - `schema`: derived from the schema's declared type
 * - `no-schema`: nothing honest was derivable, so the seed is `null`
 */
export type SeedSource = 'enum' | 'schema' | 'no-schema';

/** A parameter, with whatever the spec could add to discovery's name. */
export interface RpcMethodParam extends ApiMethodParam {
	/** JSON Schema from the spec, `$ref`s resolved where resolvable. */
	schema?: JsonSchema;
	/**
	 * Whether the SCHEMA marks this parameter required. Deliberately separate
	 * from `optional`, which discovery sets from the source signature: a
	 * positional parameter and its schema can disagree, and flattening the two
	 * would lose that signal.
	 */
	required?: boolean;
	/** A starting point for the form. See {@link SEED_NOTICE} — never a default. */
	seedValue?: unknown;
	seedSource?: SeedSource;
	/** Set when a `$ref` could not be resolved, naming the reference. */
	schemaWarning?: string;
	/** True when the spec declares this parameter and the source does not. */
	specOnly?: boolean;
}

/** The spec's declared result for a method, when it has one. */
export interface RpcMethodResult {
	schema?: JsonSchema;
	type?: string;
	schemaWarning?: string;
}

/** Which source(s) a listed method came from. */
export type RpcMethodOrigin = 'source' | 'source+spec' | 'spec-only';

/** A callable method: discovery's `ApiMethod`, never diminished. */
export interface RpcMethod extends ApiMethod {
	params: RpcMethodParam[];
	origin: RpcMethodOrigin;
	result?: RpcMethodResult;
}

/** A namespace whose methods carry the catalogue's enrichment. */
export interface RpcCatalogueNamespace extends RpcNamespace {
	methods: RpcMethod[];
}

export interface RpcMethodCatalogue {
	methodsSource: 'spec' | 'source-scan' | 'unavailable';
	methodsError?: string;
	namespaces: RpcCatalogueNamespace[];
}

/** Reads the spec file; returns undefined when there is none. Test seam. */
export type SpecFileReader = (path: string) => string | undefined;

const REF_PREFIX = '#/components/schemas/';

const NO_API_MESSAGE =
	'This app declares no ApiNamespace block, so it exposes no RPC methods to call. Add one to aws-blocks/ to use the playground.';

// ── spec parsing ────────────────────────────────────────────────────────────

/** One parameter as the spec declares it. */
interface SpecParam {
	name: string;
	required?: boolean;
	schema?: JsonSchema;
	unresolvedRef?: string;
}

/** One method as the spec declares it, keyed later by `namespace.method`. */
interface SpecMethod {
	namespace: string;
	method: string;
	params: SpecParam[];
	result?: RpcMethodResult;
}

interface ParsedSpec {
	methods: Map<string, SpecMethod>;
}

/** Outcome of looking for and reading the spec file. */
interface LoadedSpec {
	present: boolean;
	spec?: ParsedSpec;
	error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function describeKind(value: unknown): string {
	if (value === undefined) return 'missing';
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'an array';
	return `a ${typeof value}`;
}

function tryParseJson(text: string): { value: unknown } | { parseError: string } {
	try {
		return { value: JSON.parse(text) as unknown };
	} catch (error) {
		return { parseError: messageOf(error) };
	}
}

function isRefSchema(value: unknown): boolean {
	const record = asRecord(value);
	return record !== undefined && typeof record.$ref === 'string';
}

/**
 * Resolve a local `$ref` into `components.schemas`, ONE level.
 *
 * An unresolvable reference is left exactly as written rather than replaced by
 * an invented type — the caller reports it on the parameter instead.
 */
function resolveSchema(
	raw: unknown,
	components: Record<string, JsonSchema>,
): { schema?: JsonSchema; unresolvedRef?: string } {
	const schema = asRecord(raw);
	if (schema === undefined) return {};
	const ref = schema.$ref;
	if (typeof ref !== 'string') return { schema };
	if (!ref.startsWith(REF_PREFIX)) return { schema, unresolvedRef: ref };
	const target = components[ref.slice(REF_PREFIX.length)];
	if (target === undefined) return { schema, unresolvedRef: ref };
	// One level: the resolved schema's own $refs are left untouched.
	return { schema: { ...target } };
}

/**
 * Resolve the parameter's schema and, when its `items` is itself a bare `$ref`,
 * that too. Both are single resolutions at their own position — neither recurses
 * into what came back.
 */
function resolveParamSchema(
	raw: unknown,
	components: Record<string, JsonSchema>,
): { schema?: JsonSchema; unresolvedRef?: string } {
	const top = resolveSchema(raw, components);
	if (top.schema === undefined || !isRefSchema(top.schema.items)) return top;
	const inner = resolveSchema(top.schema.items, components);
	return {
		schema: { ...top.schema, items: inner.schema ?? top.schema.items },
		unresolvedRef: top.unresolvedRef ?? inner.unresolvedRef,
	};
}

function readComponentSchemas(root: Record<string, unknown>): Record<string, JsonSchema> {
	const components = asRecord(root.components);
	const schemas = components === undefined ? undefined : asRecord(components.schemas);
	if (schemas === undefined) return {};
	const resolved: Record<string, JsonSchema> = {};
	for (const [name, value] of Object.entries(schemas)) {
		const schema = asRecord(value);
		if (schema !== undefined) resolved[name] = schema;
	}
	return resolved;
}

function parseSpecParams(raw: unknown, components: Record<string, JsonSchema>): SpecParam[] {
	if (!Array.isArray(raw)) return [];
	const params: SpecParam[] = [];
	for (const entry of raw) {
		const record = asRecord(entry);
		if (record === undefined) continue;
		const name = record.name;
		if (typeof name !== 'string' || name.length === 0) continue;
		const { schema, unresolvedRef } = resolveParamSchema(record.schema, components);
		const param: SpecParam = { name };
		if (typeof record.required === 'boolean') param.required = record.required;
		if (schema !== undefined) param.schema = schema;
		if (unresolvedRef !== undefined) param.unresolvedRef = unresolvedRef;
		params.push(param);
	}
	return params;
}

function parseSpecResult(raw: unknown, components: Record<string, JsonSchema>): RpcMethodResult | undefined {
	const record = asRecord(raw);
	if (record === undefined) return undefined;
	const { schema, unresolvedRef } = resolveParamSchema(record.schema, components);
	if (schema === undefined && unresolvedRef === undefined) return undefined;
	const result: RpcMethodResult = {};
	if (schema !== undefined) result.schema = schema;
	const typeText = schemaTypeText(schema);
	if (typeText !== undefined) result.type = typeText;
	if (unresolvedRef !== undefined) result.schemaWarning = unresolvedRefWarning(unresolvedRef);
	return result;
}

/**
 * Parse the OpenRPC document into a `namespace.method` index.
 *
 * A method whose `name` is not `namespace.method` is skipped: it cannot be
 * addressed through a namespace, so listing it would offer an uncallable entry.
 */
function parseOpenRpc(text: string, specPath: string): { spec?: ParsedSpec; error?: string } {
	const parsed = tryParseJson(text);
	if ('parseError' in parsed) {
		return {
			error: `Could not parse ${specPath}: ${parsed.parseError}. Falling back to source-scanned method names — regenerate the spec with blocks-generate-spec.`,
		};
	}
	const root = asRecord(parsed.value);
	if (root === undefined) {
		return {
			error: `${specPath} is not an OpenRPC document: the top level is ${describeKind(parsed.value)}, expected an object. Falling back to source-scanned method names.`,
		};
	}
	if (!Array.isArray(root.methods)) {
		return {
			error: `${specPath} is not an OpenRPC document: "methods" is ${describeKind(root.methods)}, expected an array. Falling back to source-scanned method names.`,
		};
	}
	const components = readComponentSchemas(root);
	const methods = new Map<string, SpecMethod>();
	for (const entry of root.methods) {
		const record = asRecord(entry);
		if (record === undefined) continue;
		const name = record.name;
		if (typeof name !== 'string') continue;
		const separator = name.indexOf('.');
		if (separator <= 0 || separator === name.length - 1) continue;
		const namespace = name.slice(0, separator);
		const method = name.slice(separator + 1);
		const specMethod: SpecMethod = {
			namespace,
			method,
			params: parseSpecParams(record.params, components),
		};
		const result = parseSpecResult(record.result, components);
		if (result !== undefined) specMethod.result = result;
		methods.set(`${namespace}.${method}`, specMethod);
	}
	return { spec: { methods } };
}

// ── spec file loading, cached on mtime + size ───────────────────────────────

interface CacheEntry {
	stamp: string;
	loaded: LoadedSpec;
}

const specCache = new Map<string, CacheEntry>();

/** Drop the cached spec parses. Exported for tests and for a forced reload. */
export function clearRpcSpecCache(): void {
	specCache.clear();
}

function statStamp(specPath: string): string | undefined {
	try {
		const stats = statSync(specPath);
		if (!stats.isFile()) return undefined;
		return `${stats.mtimeMs}:${stats.size}`;
	} catch {
		return undefined;
	}
}

function readFileSafely(specPath: string): string | undefined {
	try {
		return readFileSync(specPath, 'utf-8');
	} catch {
		return undefined;
	}
}

function toLoaded(text: string | undefined, specPath: string): LoadedSpec {
	if (text === undefined) return { present: false };
	const { spec, error } = parseOpenRpc(text, specPath);
	if (error !== undefined) return { present: true, error };
	return { present: true, spec };
}

/**
 * Read and parse the spec, caching the parse by mtime + size so an edited spec
 * is picked up without re-reading the file on every request.
 *
 * An injected reader bypasses the cache entirely: there is no file to stat, and
 * a test that seeds different content per call must see exactly that.
 */
function loadSpec(specPath: string, readSpecFile?: SpecFileReader): LoadedSpec {
	if (readSpecFile !== undefined) return toLoaded(readSpecFile(specPath), specPath);
	const stamp = statStamp(specPath);
	if (stamp === undefined) return { present: false };
	const cached = specCache.get(specPath);
	if (cached !== undefined && cached.stamp === stamp) return cached.loaded;
	const loaded = toLoaded(readFileSafely(specPath), specPath);
	specCache.set(specPath, { stamp, loaded });
	return loaded;
}

// ── seeds and type text ─────────────────────────────────────────────────────

function firstType(type: unknown): string | undefined {
	if (typeof type === 'string') return type;
	if (!Array.isArray(type)) return undefined;
	for (const entry of type) {
		if (typeof entry === 'string' && entry !== 'null') return entry;
	}
	for (const entry of type) {
		if (entry === 'null') return 'null';
	}
	return undefined;
}

/**
 * A starting point for the form, derived from the schema. `null` whenever
 * nothing honest is derivable — an invented value would read as a default.
 */
export function deriveSeed(schema: JsonSchema | undefined): { value: unknown; source: SeedSource } {
	if (schema === undefined) return { value: null, source: 'no-schema' };
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		return { value: schema.enum[0], source: 'enum' };
	}
	switch (firstType(schema.type)) {
		case 'string':
			return { value: '', source: 'schema' };
		case 'number':
		case 'integer':
			return { value: 0, source: 'schema' };
		case 'boolean':
			return { value: false, source: 'schema' };
		case 'array':
			return { value: [], source: 'schema' };
		case 'object':
			return { value: {}, source: 'schema' };
		case 'null':
			return { value: null, source: 'schema' };
		default:
			return { value: null, source: 'no-schema' };
	}
}

function scalarTypeText(type: string): string {
	if (type === 'integer') return 'number';
	if (type === 'array') return 'unknown[]';
	if (type === 'object') return 'object';
	return type;
}

function enumTypeText(values: unknown[]): string {
	const parts = values.map((value) => (typeof value === 'string' ? `'${value}'` : String(value)));
	return [...new Set(parts)].join(' | ');
}

/**
 * TypeScript-ish text for a schema, for the form's label.
 *
 * Returns undefined for an unresolved `$ref` — the reference name is not the
 * type, and guessing one there is exactly what the spec forbids.
 */
export function schemaTypeText(schema: JsonSchema | undefined): string | undefined {
	if (schema === undefined) return undefined;
	if (typeof schema.$ref === 'string') return undefined;
	if (Array.isArray(schema.enum) && schema.enum.length > 0) return enumTypeText(schema.enum);
	const type = schema.type;
	if (Array.isArray(type)) {
		const parts = type.filter((entry): entry is string => typeof entry === 'string').map(scalarTypeText);
		if (parts.length === 0) return undefined;
		return [...new Set(parts)].join(' | ');
	}
	if (typeof type !== 'string') return typeof schema.title === 'string' ? schema.title : undefined;
	if (type === 'array') {
		const inner = schemaTypeText(asRecord(schema.items));
		return inner === undefined ? 'unknown[]' : `${inner}[]`;
	}
	if (type === 'object') return typeof schema.title === 'string' ? schema.title : 'object';
	return scalarTypeText(type);
}

function unresolvedRefWarning(ref: string): string {
	return `Schema reference ${ref} could not be resolved in the spec's components.schemas; the $ref is left as written and no type is claimed.`;
}

// ── merging ─────────────────────────────────────────────────────────────────

/** Copy discovery's parameter and add whatever the spec knows. Never mutates. */
function enrichParam(param: ApiMethodParam, specParam: SpecParam | undefined): RpcMethodParam {
	const enriched: RpcMethodParam = { ...param };
	if (specParam === undefined) return enriched;
	if (specParam.schema !== undefined) enriched.schema = specParam.schema;
	if (specParam.required !== undefined) enriched.required = specParam.required;
	const typeText = schemaTypeText(specParam.schema);
	if (typeText !== undefined) enriched.type = typeText;
	const seed = deriveSeed(specParam.schema);
	enriched.seedValue = seed.value;
	enriched.seedSource = seed.source;
	if (specParam.unresolvedRef !== undefined) enriched.schemaWarning = unresolvedRefWarning(specParam.unresolvedRef);
	return enriched;
}

function specOnlyParam(specParam: SpecParam): RpcMethodParam {
	return { ...enrichParam({ name: specParam.name }, specParam), specOnly: true };
}

/**
 * Merge one discovered method with its spec entry.
 *
 * Parameters are matched BY NAME only. A positional fallback would attach a
 * type to the wrong parameter whenever the spec drifted, and a confidently
 * wrong type is worse than no type. A spec parameter with no counterpart in the
 * source is appended, flagged, so the extra information is not lost either.
 */
function mergeMethod(method: ApiMethod, specMethod: SpecMethod): RpcMethod {
	const byName = new Map(specMethod.params.map((param) => [param.name, param]));
	const params = method.params.map((param) => enrichParam(param, byName.get(param.name)));
	const discoveredNames = new Set(method.params.map((param) => param.name));
	for (const specParam of specMethod.params) {
		if (!discoveredNames.has(specParam.name)) params.push(specOnlyParam(specParam));
	}
	const merged: RpcMethod = { ...method, params, origin: 'source+spec' };
	if (specMethod.result !== undefined) merged.result = specMethod.result;
	return merged;
}

function sourceOnlyMethod(method: ApiMethod): RpcMethod {
	return { ...method, params: method.params.map((param) => ({ ...param })), origin: 'source' };
}

function specOnlyMethod(specMethod: SpecMethod): RpcMethod {
	const method: RpcMethod = {
		name: specMethod.method,
		params: specMethod.params.map(specOnlyParam),
		origin: 'spec-only',
	};
	if (specMethod.result !== undefined) method.result = specMethod.result;
	return method;
}

function compareStrings(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/** A block that can serve RPC: an ApiNamespace, or anything with methods. */
function isApiNamespaceBlock(block: DiscoveredBlock): boolean {
	return block.type === API_NAMESPACE_BLOCK_TYPE || Array.isArray(block.methods);
}

/**
 * Build the catalogue: discovery's methods, supplemented by the generated spec.
 *
 * `methodsSource` reports what the listed methods actually got:
 * - `'spec'` — a parseable spec contributed types (it covered at least one
 *   discovered method, or supplied methods where discovery found none)
 * - `'source-scan'` — names only: no spec, an unparseable one (see
 *   `methodsError`), or a spec so stale it covered nothing
 * - `'unavailable'` — the app declares no ApiNamespace block at all
 */
export async function buildRpcMethodCatalogue(
	projectRoot: string,
	blocks: DiscoveredBlock[],
	readSpecFile?: SpecFileReader,
): Promise<RpcMethodCatalogue> {
	const apiBlocks = blocks.filter(isApiNamespaceBlock);
	if (apiBlocks.length === 0) {
		return { methodsSource: 'unavailable', methodsError: NO_API_MESSAGE, namespaces: [] };
	}

	const specPath = join(projectRoot, SPEC_FILE_RELATIVE_PATH);
	const loaded = loadSpec(specPath, readSpecFile);
	const spec = loaded.spec;

	let discoveredCount = 0;
	let enrichedCount = 0;
	let specOnlyCount = 0;

	const namespaces: RpcCatalogueNamespace[] = apiBlocks.map((block) => {
		const discovered = block.methods ?? [];
		discoveredCount += discovered.length;
		const methods: RpcMethod[] = discovered.map((method) => {
			const specMethod = spec?.methods.get(`${block.id}.${method.name}`);
			if (specMethod === undefined) return sourceOnlyMethod(method);
			enrichedCount += 1;
			return mergeMethod(method, specMethod);
		});
		if (spec !== undefined) {
			const known = new Set(discovered.map((method) => method.name));
			const extras = [...spec.methods.values()]
				.filter((specMethod) => specMethod.namespace === block.id && !known.has(specMethod.method))
				.sort((a, b) => compareStrings(a.method, b.method));
			specOnlyCount += extras.length;
			for (const specMethod of extras) methods.push(specOnlyMethod(specMethod));
		}
		return { namespace: block.id, blockFullId: block.fullId, methods };
	});
	// Sorted by namespace id: a list that reorders between requests is unusable,
	// and this holds even if discovery's block order changes.
	namespaces.sort((a, b) => compareStrings(a.namespace, b.namespace));

	if (loaded.error !== undefined) {
		return { methodsSource: 'source-scan', methodsError: loaded.error, namespaces };
	}

	const contributed = enrichedCount > 0 || (discoveredCount === 0 && specOnlyCount > 0);
	const catalogue: RpcMethodCatalogue = {
		methodsSource: spec !== undefined && contributed ? 'spec' : 'source-scan',
		namespaces,
	};

	// A namespace the spec declares and the source does not is LISTED, not
	// dropped with a note. It is very often not stale at all: `auth.createApi()`
	// returns a namespace from a factory method, so a source scan that resolves
	// constructor calls cannot see it, while the spec — generated by introspecting
	// the running backend — can. Such a namespace answers real calls, verified
	// against a live dev server, so hiding it would remove working methods from
	// the playground and blame the user's spec for our blind spot.
	if (spec !== undefined) {
		const known = new Set(namespaces.map((entry) => entry.namespace));
		const orphanedNames = [...new Set([...spec.methods.values()].map((method) => method.namespace))]
			.filter((namespace) => !known.has(namespace))
			.sort(compareStrings);
		for (const namespace of orphanedNames) {
			const methods = [...spec.methods.values()]
				.filter((specMethod) => specMethod.namespace === namespace)
				.sort((a, b) => compareStrings(a.method, b.method))
				.map((specMethod) => specOnlyMethod(specMethod));
			specOnlyCount += methods.length;
			// No blockFullId: there is no discovered block to attribute it to, and
			// inventing one would misreport where the namespace comes from.
			namespaces.push({ namespace, methods });
		}
		if (orphanedNames.length > 0) {
			namespaces.sort((a, b) => compareStrings(a.namespace, b.namespace));
			catalogue.methodsSource = 'spec';
			catalogue.methodsError =
				`${specPath} declares ${orphanedNames.length === 1 ? 'a namespace' : 'namespaces'} the source scan ` +
				`did not find: ${orphanedNames.join(', ')}. Listed anyway — a namespace built by a factory such as ` +
				'`auth.createApi()` is invisible to a source scan but perfectly callable. If it no longer exists in ' +
				'the app, the spec is stale; regenerate it with blocks-generate-spec.';
		}
	}

	return catalogue;
}
