// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CannedProvider — a fake Strands model provider for local dev.
 * Returns keyword-based responses without calling any real model.
 * Speaks the same ModelStreamEvent protocol as Bedrock/OpenAI,
 * so Strands processes it identically to a real provider.
 *
 * Tool call support: if the prompt mentions a tool name from the available toolSpecs,
 * emits toolUse events so Strands executes the tool. On the follow-up call (with tool
 * result in messages), emits a simple text summary.
 *
 * @see https://strandsagents.com/docs/user-guide/concepts/model-providers/custom_model_provider/
 */

import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Model } from '@strands-agents/sdk';
import type { Message, ModelStreamEvent, StreamOptions } from '@strands-agents/sdk';
import { AgentErrors, blocksAgentError } from '../errors.js';
import { ToolResultBlock } from '@strands-agents/sdk';
import type { CannedToolHints } from '../types.js';

interface CannedConfig {
	modelId: string;
}

interface CannedProviderOptions {
	modelId?: string;
	/** Per-tool hints (examples, triggers) keyed by tool name. */
	hints?: Map<string, CannedToolHints>;
	/** Custom phrase-to-response dictionary, or a path to a JSON dictionary. */
	responses?: Record<string, string> | string;
}

const CANNED_RESPONSES: Record<string, string> = {
	weather: 'The weather is 22°C and sunny. [canned response]',
	order: 'Order #12345 has been shipped and is on its way. [canned response]',
	help: 'I can help you with weather, orders, and general questions. [canned response]',
};

const DEFAULT_RESPONSE = 'This is a canned mock response. No real model was called. [canned]';

/**
 * Pick a canned text response from a custom dictionary or built-in keywords. Matches use
 * word boundaries for the same reason tool matching is: substring matching fired `order`
 * inside "reorder" and `help` inside "helper", the same false-positive class the tool
 * matcher avoids.
 */
function matchResponse(prompt: string, customResponses?: Record<string, string>, cache = true): { response: string; verbatim: boolean } {
	const lower = prompt.toLowerCase();
	if (customResponses) {
		for (const [phrase, response] of Object.entries(customResponses)) {
			if (wordBoundaryPattern(phrase.trim().toLowerCase(), cache).test(lower)) return { response, verbatim: true };
		}
		return { response: DEFAULT_RESPONSE, verbatim: false };
	}
	for (const [keyword, response] of Object.entries(CANNED_RESPONSES)) {
		if (promptMentionsWord(lower, keyword)) return { response, verbatim: false };
	}
	return { response: DEFAULT_RESPONSE, verbatim: false };
}

/** Keep `cause` server-side: non-enumerable, so `JSON.stringify` cannot carry it to a client. */
function withCause(err: Error, cause: unknown): Error {
	Object.defineProperty(err, 'cause', { value: cause, enumerable: false, writable: true, configurable: true });
	return err;
}

/**
 * Validate the parsed dictionary before using it to select a response. Failures are branded
 * `InvalidModelConfig` errors, so a failed turn reports them on the `error` chunk instead of a
 * generic message. Because that message reaches the client, it never quotes the dictionary's
 * contents: the offending phrase rides on the non-enumerable `cause` (logged by the agent).
 */
function validateResponses(value: unknown, source: string): Record<string, string> {
	if (!value || Array.isArray(value) || typeof value !== 'object') {
		throw blocksAgentError(AgentErrors.InvalidModelConfig, `${source} must be an object mapping phrases to response strings.`);
	}
	for (const [phrase, response] of Object.entries(value)) {
		if (!phrase.trim()) throw blocksAgentError(AgentErrors.InvalidModelConfig, `${source} contains a blank response phrase.`);
		if (typeof response !== 'string') {
			throw withCause(
				blocksAgentError(AgentErrors.InvalidModelConfig, `${source} has a non-string response; every response must be a string.`),
				new Error(`Offending phrase: '${phrase}'`),
			);
		}
	}
	return value as Record<string, string>;
}

/**
 * Read and parse one snapshot of a configured response file for a text selection.
 *
 * Client-visible messages name the file by basename only — never the absolute server path —
 * and never echo its contents (a V8 `SyntaxError` message quotes the malformed text, so it is
 * kept on the non-enumerable `cause`). A read failure stays unbranded: its OS error text is
 * reported to the client as a generic message and logged by the agent.
 */
async function readResponsesFile(filePath: string): Promise<Record<string, string>> {
	let contents: string;
	try {
		contents = await readFile(filePath, 'utf8');
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read canned responses file '${filePath}': ${detail}`);
	}
	const name = basename(filePath);
	try {
		return validateResponses(JSON.parse(contents), `Canned responses file '${name}'`);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw withCause(blocksAgentError(AgentErrors.InvalidModelConfig, `Malformed canned responses JSON in '${name}'.`), error);
		}
		throw error;
	}
}

const wordPatternCache = new Map<string, RegExp>();

/**
 * Compile a word-boundary matcher for a word or phrase, cached by phrase.
 * Uses Unicode letter/mark/number/underscore boundaries rather than substring `includes()` so a tool word like "cat"
 * (from `getCat`) is NOT triggered by an unrelated word like "category", and
 * "pass" (from `getPass`) is not triggered by "password". Regex metacharacters are
 * escaped so punctuation in tool names can't break the pattern, and internal
 * whitespace becomes `\s+` so a multi-word phrase tolerates irregular spacing.
 * Compiled patterns are cached because matching re-runs for every tool on every
 * `stream()` call, and the key space is bounded by the agent's tool, trigger, and inline response keys.
 * Pass `cache = false` to reuse existing patterns without retaining new file-backed phrases.
 */
function wordBoundaryPattern(phrase: string, cache = true): RegExp {
	let pattern = wordPatternCache.get(phrase);
	if (!pattern) {
		const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
		pattern = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escaped}(?![\\p{L}\\p{M}\\p{N}_])`, 'iu');
		if (cache) wordPatternCache.set(phrase, pattern);
	}
	return pattern;
}

/** Match a word against an already-lowercased prompt on word boundaries. */
function promptMentionsWord(lowerPrompt: string, word: string): boolean {
	return wordBoundaryPattern(word).test(lowerPrompt);
}

/** Find ALL tools mentioned in the prompt (for parallel tool calls). */
function findAllToolMatches(prompt: string, toolSpecs?: { name: string }[], hints?: Map<string, CannedToolHints>): string[] {
	if (!toolSpecs?.length) return [];
	const lower = prompt.toLowerCase();
	return toolSpecs.filter(t => {
		const name = t.name.toLowerCase();
		if (promptMentionsWord(lower, name)) return true;
		// Split camelCase into words (getWeather -> "get weather") and match each
		// on word boundaries. Skip short words (<=2 chars) to avoid noise.
		const words = t.name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(' ');
		if (words.some(w => w.length > 2 && promptMentionsWord(lower, w))) return true;
		// Extra trigger keywords declared via `cannedTriggers`. Single and multi-word triggers
		// both match on word boundaries (consistent with tool-name matching), so "log in" is not
		// triggered by "backlog in" and internal whitespace is flexible (matches one-or-more spaces).
		const triggers = hints?.get(t.name)?.triggers;
		return triggers?.some(tr => {
			const low = tr.trim().toLowerCase();
			return low ? wordBoundaryPattern(low).test(lower) : false;
		}) ?? false;
	}).map(t => t.name);
}

/** Check if the last message contains a tool result — means we're in the follow-up after a tool call. */
function hasToolResult(messages: Message[]): boolean {
	const last = messages[messages.length - 1];
	return last?.content?.some((block: any) =>
		'toolResult' in block || block.type === 'toolResultBlock' || ('toolUseId' in block && 'status' in block)
	) ?? false;
}

/** Extract tool result text from the last message. */
function getToolResultText(messages: Message[]): string {
	const last = messages[messages.length - 1];
	const results: string[] = [];
	for (const block of last?.content ?? []) {
		const b = block as any;
		if ('toolResult' in b || b.type === 'toolResultBlock' || ('toolUseId' in b && 'status' in b)) {
			const content = b.toolResult?.content ?? b.content ?? [];
			if (!Array.isArray(content)) { results.push(String(content)); continue; }
			results.push(content.map((c: any) => c.text ?? JSON.stringify(c)).join(' '));
		}
	}
	return results.join(' | ');
}

/** Sentinel for a property whose shape carries no usable signal (distinct from a legitimate `null`/`0`/`false`). */
const NO_PLACEHOLDER = Symbol('no-placeholder');

/**
 * Resolve one property's placeholder value, or `NO_PLACEHOLDER` if its shape gives no signal.
 * Order matters: an authored `default` (from Zod `.default()`) is the most realistic value, then
 * a fixed `const`/`enum` member, then a union variant, then a per-type placeholder. `!== undefined`
 * rather than truthiness so a `default` of `0`, `false`, or `''` is honored.
 */
function placeholderForProperty(prop: any): any {
	if (prop?.default !== undefined) return prop.default;
	if (prop?.const !== undefined) return prop.const;
	if (prop?.enum?.length) return prop.enum[0];
	// Zod unions (`z.union`, `z.discriminatedUnion`) surface as anyOf/oneOf; any one
	// satisfying variant is enough for a mock, so take the first that resolves.
	const variants = prop?.anyOf ?? prop?.oneOf;
	if (Array.isArray(variants)) {
		for (const variant of variants) {
			const resolved = placeholderForProperty(variant);
			if (resolved !== NO_PLACEHOLDER) return resolved;
		}
	}
	switch (prop?.type) {
		case 'string': return 'sample';
		case 'number':
		case 'integer': return 1;
		case 'boolean': return true;
		case 'array': return [];
		case 'object': return generatePlaceholderInput(prop);
		default: return NO_PLACEHOLDER;
	}
}

/** Generate placeholder input from a JSON Schema. Produces values that pass validation. */
function generatePlaceholderInput(schema: any): any {
	if (!schema || typeof schema !== 'object') return {};
	if (schema.type !== 'object' || !schema.properties) return {};
	const required: unknown[] = Array.isArray(schema.required) ? schema.required : [];
	const result: Record<string, any> = {};
	for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
		const value = placeholderForProperty(prop);
		if (value !== NO_PLACEHOLDER) {
			result[key] = value;
		} else if (required.includes(key)) {
			// An unrecognized shape (untyped, or a union of only unrecognized variants) yields no
			// placeholder. Omitting a *required* field makes the emitted call fail validation before
			// the tool ever runs, so fall back to a string. Optional fields stay omitted: absence is
			// valid there, and inventing a wrong-typed value would break calls that used to work.
			result[key] = 'sample';
		}
	}
	return result;
}

const warnedExampleKeys = new Set<string>();

/**
 * Warn (once per tool+field) when a `cannedExamples` key isn't a field of the tool's
 * inputSchema — almost always a typo in the hint. Only ever reached through the canned
 * provider, which is local-dev-only, so this never warns in a deployed agent. The value
 * is still merged through and nothing throws: a bad hint must not break local dev.
 * Skipped when the schema exposes no `properties`, where unknown keys are unknowable.
 */
function warnUnknownExampleKeys(toolName: string, examples: Record<string, unknown>, inputSchema?: any): void {
	const properties = inputSchema?.properties;
	if (!properties) return;
	for (const key of Object.keys(examples)) {
		if (key in properties) continue;
		const seen = `${toolName}.${key}`;
		if (warnedExampleKeys.has(seen)) continue;
		warnedExampleKeys.add(seen);
		console.warn(
			`[canned] cannedExamples for tool "${toolName}" sets "${key}", which is not a field of its ` +
			`parameters schema (${Object.keys(properties).join(', ') || 'none'}). Check for a typo — the value is still sent.`,
		);
	}
}

/**
 * Look up a tool's inputSchema from toolSpecs and generate placeholder input, shallow-merging
 * any `cannedExamples` (from hints) on top so realistic values win over generated placeholders.
 */
function getToolInput(toolName: string, toolSpecs?: { name: string; inputSchema?: any }[], hints?: Map<string, CannedToolHints>): string {
	const spec = toolSpecs?.find(t => t.name === toolName);
	const base = spec?.inputSchema ? generatePlaceholderInput(spec.inputSchema) : {};
	const examples = hints?.get(toolName)?.examples;
	if (!examples) return JSON.stringify(base);
	warnUnknownExampleKeys(toolName, examples, spec?.inputSchema);
	return JSON.stringify({ ...base, ...examples });
}

let toolCallCounter = 0;

export class CannedProvider extends Model<CannedConfig> {
	private config: CannedConfig;
	private hints: Map<string, CannedToolHints>;
	private responses?: Record<string, string>;
	private responsesFile?: string;

	constructor(options?: CannedProviderOptions) {
		super();
		this.config = { modelId: options?.modelId ?? 'canned-mock' };
		this.hints = options?.hints ?? new Map();
		if (typeof options?.responses === 'string') {
			this.responsesFile = resolve(options.responses);
		} else if (options?.responses !== undefined) {
			this.responses = { ...validateResponses(options.responses, 'Canned responses') };
		}
	}

	updateConfig(config: Partial<CannedConfig>): void {
		Object.assign(this.config, config);
	}

	getConfig(): CannedConfig {
		return { ...this.config };
	}

	async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
		const lastMessage = messages[messages.length - 1];
		const prompt = lastMessage?.content
			?.map((block) => ('text' in block ? block.text : ''))
			.join('') ?? '';

		// Follow-up after tool execution — Strands sends the tool result back to the model
		if (hasToolResult(messages)) {
			const resultText = getToolResultText(messages);
			yield* this.emitText(`I called the tool. Output: ${resultText} [canned tool response]`);
			return;
		}

		// Check if prompt mentions tool names — trigger tool call(s)
		const toolMatches = findAllToolMatches(prompt, options?.toolSpecs, this.hints);
		if (toolMatches.length > 1) {
			yield* this.emitParallelToolCalls(toolMatches, options?.toolSpecs);
			return;
		}
		const toolName = toolMatches[0];
		if (toolName) {
			yield* this.emitToolCall(toolName, options?.toolSpecs);
			return;
		}

		// Default: keyword-based text response. Read a configured file exactly once for
		// this selection so each request sees one coherent, current dictionary snapshot.
		const responses = this.responsesFile ? await readResponsesFile(this.responsesFile) : this.responses;
		const selected = matchResponse(prompt, responses, !this.responsesFile);
		yield* this.emitText(selected.response, selected.verbatim);
	}

	/** Emit a text response as ModelStreamEvents. */
	private async *emitText(response: string, verbatim = false): AsyncIterable<ModelStreamEvent> {
		yield { type: 'modelMessageStartEvent', role: 'assistant' };
		yield { type: 'modelContentBlockStartEvent' };
		if (verbatim) {
			if (response) yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: response } };
		} else {
			for (const word of response.split(' ')) {
				yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: `${word} ` } };
			}
		}
		yield { type: 'modelContentBlockStopEvent' };
		yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
		yield { type: 'modelMetadataEvent', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, metrics: { latencyMs: 0 } };
	}

	/** Emit multiple tool calls in one message (parallel execution). */
	private async *emitParallelToolCalls(toolNames: string[], toolSpecs?: { name: string; inputSchema?: any }[]): AsyncIterable<ModelStreamEvent> {
		yield { type: 'modelMessageStartEvent', role: 'assistant' };
		for (const toolName of toolNames) {
			const toolUseId = `canned-tool-${++toolCallCounter}`;
			yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: toolName, toolUseId } };
			yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: getToolInput(toolName, toolSpecs, this.hints) } };
			yield { type: 'modelContentBlockStopEvent' };
		}
		yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
		yield { type: 'modelMetadataEvent', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, metrics: { latencyMs: 0 } };
	}

	/** Emit a tool call as ModelStreamEvents. Strands executes the tool and calls stream() again with the result. */
	private async *emitToolCall(toolName: string, toolSpecs?: { name: string; inputSchema?: any }[]): AsyncIterable<ModelStreamEvent> {
		const toolUseId = `canned-tool-${++toolCallCounter}`;
		yield { type: 'modelMessageStartEvent', role: 'assistant' };
		yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: toolName, toolUseId } };
		yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: getToolInput(toolName, toolSpecs, this.hints) } };
		yield { type: 'modelContentBlockStopEvent' };
		yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
		yield { type: 'modelMetadataEvent', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, metrics: { latencyMs: 0 } };
	}
}
