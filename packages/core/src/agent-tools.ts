// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types and helper for BBs that expose operations as agent tools via `toAgentTools()`.
 * Lives in core so any BB can implement the interface without depending on `bb-agent`.
 */

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
}

export interface MethodOverrides {
	description?: string;
	/** Pin parameter values — injected server-side, stripped from what the model sees. */
	fixed?: Record<string, unknown>;
	/** Narrow or replace the parameters schema the model sees. */
	schema?: unknown;
	needsApproval?: boolean;
	trustable?: boolean;
}

/** A single tool-eligible method definition inside a BB's tool registry. */
export interface ToolMethodDef<TSelf = any> {
	description: string;
	parameters: unknown;
	needsApproval?: boolean;
	trustable?: boolean;
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
 * Build agent tools from a BB's tool method registry.
 * Handles include/exclude filtering, overrides, and scope injection.
 *
 * Returns `Record<string, any>` so the result can be spread directly into
 * an Agent's `tools` callback without type conflicts.
 */
export function buildAgentTools<TSelf extends Scope>(
	self: TSelf,
	toolMethods: Record<string, ToolMethodDef<TSelf>>,
	options?: AgentToolProviderOptions<any>,
): Record<string, any> {
	if (options?.include && options?.exclude) {
		throw new Error('toAgentTools: `include` and `exclude` are mutually exclusive');
	}

	const bbId = self.id;
	const result: Record<string, any> = {};

	for (const [methodName, def] of Object.entries(toolMethods)) {
		if (options?.include && !options.include.includes(methodName)) continue;
		if (options?.exclude && options.exclude.includes(methodName)) continue;

		const override = options?.overrides?.[methodName];
		const description = override?.description ?? def.description;
		const needsApproval = override?.needsApproval ?? def.needsApproval ?? false;
		const trustable = override?.trustable ?? def.trustable;
		const parameters = override?.schema ?? def.parameters;

		const baseHandler = def.handler(self);
		const handler = async (args: { input: any; context: any }) => {
			let input = args.input;
			if (options?.scope && args.context) {
				const scoped = options.scope(args.context);
				input = { ...input, ...scoped };
			}
			if (override?.fixed) {
				input = { ...input, ...override.fixed };
			}
			return baseHandler({ input, context: args.context });
		};

		const toolName = `${bbId}__${methodName}`;
		result[toolName] = { description, parameters, needsApproval, trustable, handler };
	}

	return result;
}
