// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types and helper for BBs that expose operations as agent tools via `toAgentTools()`.
 * Lives in core so any BB can implement the interface without depending on `bb-agent`.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Scope } from './common/index.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface AgentToolProviderOptions<TContext = any> {
	/** Only expose these methods (from the BB's tool-eligible set). Mutually exclusive with `exclude`. */
	include?: string[];
	/** Expose all tool-eligible methods except these. Mutually exclusive with `include`. */
	exclude?: string[];
	/** Per-method overrides of the BB's defaults, keyed by method name. */
	overrides?: Record<string, MethodOverrides>;
	/**
	 * Injects request-scoped fields (e.g. userId) into tool input from context.
	 * Precedence when the same key appears in multiple sources: fixed > scope > model input.
	 */
	scope?: (context: TContext) => Record<string, unknown>;
	/**
	 * Opt out of the scoping requirement for a BB that declares `requiresScope`.
	 * Asserts the store holds no per-user data (a cache, feature flags, shared config).
	 * Ignored for BBs that don't require scope.
	 */
	unscoped?: boolean;
}

export interface MethodOverrides {
	description?: string;
	/** Pin parameter values — injected server-side, stripped from what the model sees. */
	fixed?: Record<string, unknown>;
	/** Narrow or replace the parameters schema the model sees. */
	schema?: StandardSchemaV1;
	needsApproval?: boolean;
	trustable?: boolean;
}

/** A single tool-eligible method definition inside a BB's tool registry. */
export interface ToolMethodDef<TSelf = any> {
	description: string;
	parameters: unknown;
	needsApproval?: boolean;
	trustable?: boolean;
	/**
	 * Whether this method honors an injected `scope`. Defaults to true.
	 * Set false for methods whose handler ignores the scoped fields (e.g. a `scan`
	 * that lists the whole store): under `scope` such a method would run unscoped and
	 * leak across users, so `buildAgentTools` throws if it is exposed on a scoped BB.
	 */
	scopeSafe?: boolean;
	// `input: any` because parameters are JSON Schema objects — no compile-time type link.
	// Core avoids a zod dependency, so we can't derive input types from the schema.
	handler: (self: TSelf) => (args: { input: any; context: any }) => Promise<unknown>;
}

/** Contract that BBs implement to expose operations as agent tools. */
export interface AgentToolProvider {
	toAgentTools<TContext = any>(options?: AgentToolProviderOptions<TContext>): Record<string, any>;
}

// ── Builder ─────────────────────────────────────────────────────────────────

/**
 * Discover the key names a `scope` callback injects, without a request context.
 * The documented pattern maps context fields to a fixed set of keys
 * (`(ctx) => ({ key: ctx.userId })`), so we probe with a proxy that tolerates any
 * property access and read the returned object's keys. Falls back to no stripping
 * if the callback throws or returns a non-object.
 */
function discoverScopeKeys(scope?: (context: any) => Record<string, unknown>): string[] {
	if (!scope) return [];
	try {
		const probe = new Proxy({}, { get: () => '' });
		const injected = scope(probe);
		return injected && typeof injected === 'object' ? Object.keys(injected) : [];
	} catch {
		return [];
	}
}

/**
 * Remove server-injected keys from a JSON Schema `parameters` object so the model
 * never sees a field it can't control. Only applies to plain JSON Schema objects;
 * a Standard Schema override is returned untouched (core can't `.omit()` generically
 * without depending on a concrete validation library — a BB that authors its
 * parameters with a schema library omits scoped fields itself before this point).
 */
function stripKeysFromParameters(parameters: unknown, keys: string[]): unknown {
	if (keys.length === 0 || !parameters || typeof parameters !== 'object') return parameters;
	if ('~standard' in parameters) return parameters;
	const schema = parameters as { properties?: Record<string, unknown>; required?: string[] };
	if (!schema.properties || typeof schema.properties !== 'object') return parameters;
	const properties = { ...schema.properties };
	for (const key of keys) delete properties[key];
	const required = Array.isArray(schema.required)
		? schema.required.filter((name) => !keys.includes(name))
		: schema.required;
	return { ...schema, properties, required };
}

/** Build-time configuration a BB passes to describe its tool registry. */
export interface BuildAgentToolsConfig {
	/**
	 * The BB can hold per-user data. When true, `buildAgentTools` throws unless the
	 * caller passes either `scope` or `unscoped: true`, so an accidental unscoped
	 * spread can't quietly expose every user's data.
	 */
	requiresScope?: boolean;
}

/**
 * Build agent tools from a BB's tool method registry.
 * Handles include/exclude filtering, overrides, scope injection, and the
 * scoping requirement for BBs that hold per-user data.
 *
 * Returns `Record<string, any>` — this bypasses the Agent BB's branded AgentTool type
 * check. Core can't import the brand without a circular dep, so shape/override errors
 * are caught at runtime, not compile time. The tool() factory remains the type-safe path.
 */
export function buildAgentTools<TSelf extends Scope>(
	self: TSelf,
	toolMethods: Record<string, ToolMethodDef<TSelf>>,
	options?: AgentToolProviderOptions<any>,
	config?: BuildAgentToolsConfig,
): Record<string, any> {
	if (options?.include && options?.exclude) {
		throw new Error('toAgentTools: `include` and `exclude` are mutually exclusive');
	}

	const bbId = self.id;

	// A BB that can hold per-user data must be scoped to the caller or explicitly
	// opted out. Throws at construction so the mistake never reaches production.
	if (config?.requiresScope && !options?.scope && !options?.unscoped) {
		throw new Error(
			`toAgentTools: ${self.constructor.name} "${bbId}" holds per-user data — pass \`scope\` to lock it to the caller, or \`unscoped: true\` if it is shared`,
		);
	}
	const result: Record<string, any> = {};

	// Keys injected by `scope` are the same for every method; discover them once.
	const scopeKeys = discoverScopeKeys(options?.scope);

	for (const [methodName, def] of Object.entries(toolMethods)) {
		if (options?.include && !options.include.includes(methodName)) continue;
		if (options?.exclude && options.exclude.includes(methodName)) continue;

		// A method whose handler ignores the scoped fields (scopeSafe: false) would run
		// unscoped under `scope` and leak across users. Throw so the caller excludes it
		// or opts the whole store out of scoping.
		if (options?.scope && def.scopeSafe === false) {
			throw new Error(
				`toAgentTools: "${methodName}" cannot be scope-isolated on ${self.constructor.name} "${bbId}" — its handler ignores the scoped fields, so under \`scope\` it would return data across users. Either exclude it (e.g. \`exclude: ['${methodName}']\`), or pass \`unscoped: true\` if this store is shared and cross-user results are intended.`,
			);
		}

		const override = options?.overrides?.[methodName];
		const description = override?.description ?? def.description;
		const needsApproval = override?.needsApproval ?? def.needsApproval ?? false;
		const trustable = override?.trustable ?? def.trustable;

		// Fields injected server-side (scope + fixed) are stripped from what the model
		// sees, so it never receives a parameter it can't control.
		const injectedKeys = [...scopeKeys, ...Object.keys(override?.fixed ?? {})];
		const parameters = stripKeysFromParameters(override?.schema ?? def.parameters, injectedKeys);

		const toolName = `${bbId}__${methodName}`;
		const baseHandler = def.handler(self);
		const handler = async (args: { input: any; context: any }) => {
			let input = args.input;
			if (options?.scope) {
				// A scoped tool must never run without context — that would silently drop
				// the isolation field and call the store unscoped. Fail loud instead.
				if (args.context == null) {
					throw new Error(
						`toAgentTools: "${toolName}" is scoped but was invoked without a context — cannot derive the scoped fields. Pass \`context\` when calling the agent.`,
					);
				}
				const scoped = options.scope(args.context);
				input = { ...input, ...scoped };
			}
			if (override?.fixed) {
				input = { ...input, ...override.fixed };
			}
			return baseHandler({ input, context: args.context });
		};

		result[toolName] = { description, parameters, needsApproval, trustable, handler };
	}

	return result;
}
