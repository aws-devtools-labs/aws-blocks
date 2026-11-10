// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { blocksError, KnowledgeBaseErrors } from './errors.js';
import type {
	KnowledgeBaseAgentTool,
	KnowledgeBaseAgentToolOptions,
	KnowledgeBaseAgentToolResult,
	RetrieveOptions,
	RetrieveResult,
} from './types.js';

/** Default results per agent search: enough context without flooding the model. */
const DEFAULT_AGENT_TOOL_MAX_RESULTS = 5;

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
	const { filter, maxResults = DEFAULT_AGENT_TOOL_MAX_RESULTS } = options;
	const description =
		options.description ??
		`Search the knowledge base${kbDescription ? ` (${kbDescription})` : ''} for passages relevant to a natural-language query.`;
	return {
		description,
		parameters: z.object({ query: z.string().min(1).describe('Natural-language search query') }),
		untrustedOutput: true,
		handler: async ({ input, context }): Promise<KnowledgeBaseAgentToolResult[]> => {
			// The filter comes only from the per-call context, never from the model's input.
			const scope = await filter(context);
			const results = await retrieve(input.query, { maxResults, ...(scope && { filter: scope }) });
			return results.map((r) => ({ text: r.text, score: r.score, source: r.source, metadata: { ...r.metadata } }));
		},
	};
}
