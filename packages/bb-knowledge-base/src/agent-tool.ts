// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { blocksError, KnowledgeBaseErrors } from './errors.js';
import { normalizeMaxResults } from './normalize.js';
import type {
	KnowledgeBaseAgentTool,
	KnowledgeBaseAgentToolOptions,
	KnowledgeBaseAgentToolResult,
	MetadataFilter,
	RetrieveOptions,
	RetrieveResult,
} from './types.js';

/** Default results per agent search: enough context without flooding the model. */
const DEFAULT_AGENT_TOOL_MAX_RESULTS = 5;

/**
 * Check what the `filter` callback returned. `undefined` means "search everything" and is the
 * only way to say so: anything else must be a filter that actually narrows the search. A `null`,
 * an empty object or a condition with a missing/empty `equals` would otherwise run unscoped on
 * AWS (or match unrelated documents in the mock), so it fails the tool call instead.
 */
function checkScope(scope: unknown): MetadataFilter | undefined {
	if (scope === undefined) return undefined;
	const fail = (why: string): never => {
		throw blocksError(
			KnowledgeBaseErrors.ValidationError,
			`asAgentTool() filter callback ${why}. Return a filter such as { tenant: { equals: 'acme' } }, ` +
				'return undefined to search the whole knowledge base, or throw to fail the call.',
		);
	};
	if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return fail(`returned ${scope === null ? 'null' : typeof scope}`);
	const entries = Object.entries(scope);
	if (entries.length === 0) return fail('returned an empty filter');
	for (const [key, condition] of entries) {
		const equals: unknown = condition !== null && typeof condition === 'object' ? (condition as { equals?: unknown }).equals : undefined;
		if (typeof equals !== 'string' || equals.length === 0) return fail(`returned no non-empty string \`equals\` for "${key}"`);
	}
	return scope as MetadataFilter;
}

/**
 * @internal Build the `asAgentTool()` definition shared by the mock, AWS and CDK entries.
 * `retrieve` is the owning KnowledgeBase's own `retrieve` (under CDK it throws `synthGuard`'s
 * error, so the tool can be declared at synth but only runs at runtime).
 */
export function createAgentTool<TContext>(
	retrieve: (query: string, options?: RetrieveOptions) => Promise<RetrieveResult[]>,
	options: KnowledgeBaseAgentToolOptions<TContext>,
	kbDescription: string | undefined,
): KnowledgeBaseAgentTool<TContext> {
	if (typeof options?.filter !== 'function') {
		throw blocksError(
			KnowledgeBaseErrors.ValidationError,
			'asAgentTool() needs a `filter` callback that derives the metadata filter from the tool context ' +
				'(the authenticated session). Pass `filter: () => undefined` to search the whole knowledge base.',
		);
	}
	const { filter } = options;
	// Validate now, so a bad value fails at `asAgentTool()` rather than on every tool call.
	const maxResults = normalizeMaxResults(options.maxResults ?? DEFAULT_AGENT_TOOL_MAX_RESULTS);
	const description =
		options.description ??
		`Search the knowledge base${kbDescription ? ` (${kbDescription})` : ''} for passages relevant to a natural-language query.`;
	return {
		description,
		parameters: z.object({ query: z.string().trim().min(1).describe('Natural-language search query') }),
		untrustedOutput: true,
		handler: async ({ input, context }): Promise<KnowledgeBaseAgentToolResult[]> => {
			// The filter comes only from the per-call context, never from the model's input.
			const scope = checkScope(await filter(context));
			const results = await retrieve(input.query, { maxResults, ...(scope && { filter: scope }) });
			return results.map((r) => ({ text: r.text, score: r.score, source: r.source, metadata: { ...r.metadata } }));
		},
	};
}
