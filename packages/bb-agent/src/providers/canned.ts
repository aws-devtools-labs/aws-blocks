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

import { Model } from '@strands-agents/sdk';
import type { Message, ModelStreamEvent, StreamOptions } from '@strands-agents/sdk';
import { ToolResultBlock } from '@strands-agents/sdk';

interface CannedConfig {
	modelId: string;
}

const CANNED_RESPONSES: Record<string, string> = {
	weather: 'The weather is 22°C and sunny. [canned response]',
	order: 'Order #12345 has been shipped and is on its way. [canned response]',
	help: 'I can help you with weather, orders, and general questions. [canned response]',
};

const DEFAULT_RESPONSE = 'This is a canned mock response. No real model was called. [canned]';

function matchResponse(prompt: string): string {
	const lower = prompt.toLowerCase();
	for (const [keyword, response] of Object.entries(CANNED_RESPONSES)) {
		if (lower.includes(keyword)) return response;
	}
	return DEFAULT_RESPONSE;
}

/**
 * Match a single word against the prompt on word boundaries (case-insensitive).
 * Uses `\b...\b` rather than substring `includes()` so a tool word like "cat"
 * (from `getCat`) is NOT triggered by an unrelated word like "category", and
 * "pass" (from `getPass`) is not triggered by "password". The word is regex-
 * escaped so punctuation in tool names can't break the pattern.
 */
function promptMentionsWord(lowerPrompt: string, word: string): boolean {
	const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`\\b${escaped}\\b`).test(lowerPrompt);
}

/** Find ALL tools mentioned in the prompt (for parallel tool calls). */
function findAllToolMatches(prompt: string, toolSpecs?: { name: string }[]): string[] {
	if (!toolSpecs?.length) return [];
	const lower = prompt.toLowerCase();
	return toolSpecs.filter(t => {
		const name = t.name.toLowerCase();
		if (promptMentionsWord(lower, name)) return true;
		// Split into words and match each on word boundaries. Handles camelCase
		// (getWeather -> "get weather") and the `{bbId}__{method}` convention that
		// `toAgentTools()` generates (memory__get -> "memory get"). Skip short words
		// (<=2 chars) to avoid noise.
		const words = t.name
			.replace(/([a-z])([A-Z])/g, '$1 $2')
			.replace(/_+/g, ' ')
			.toLowerCase()
			.split(' ');
		return words.some(w => w.length > 2 && promptMentionsWord(lower, w));
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

/** Generate placeholder input from a JSON Schema. Produces values that pass validation. */
function generatePlaceholderInput(schema: any): any {
	if (!schema || typeof schema !== 'object') return {};
	if (schema.type === 'object' && schema.properties) {
		const result: Record<string, any> = {};
		for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
			if (prop.type === 'string') {
				if (prop.enum?.length) result[key] = prop.enum[0];
				else result[key] = 'sample';
			} else if (prop.type === 'number' || prop.type === 'integer') {
				result[key] = 1;
			} else if (prop.type === 'boolean') {
				result[key] = true;
			} else if (prop.type === 'array') {
				result[key] = [];
			} else if (prop.type === 'object') {
				result[key] = generatePlaceholderInput(prop);
			}
		}
		return result;
	}
	return {};
}

/** Look up a tool's inputSchema from toolSpecs and generate placeholder input. */
function getToolInput(toolName: string, toolSpecs?: { name: string; inputSchema?: any }[]): string {
	const spec = toolSpecs?.find(t => t.name === toolName);
	if (!spec?.inputSchema) return '{}';
	return JSON.stringify(generatePlaceholderInput(spec.inputSchema));
}

let toolCallCounter = 0;

export class CannedProvider extends Model<CannedConfig> {
	private config: CannedConfig;

	constructor(config?: Partial<CannedConfig>) {
		super();
		this.config = { modelId: config?.modelId ?? 'canned-mock' };
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
		const toolMatches = findAllToolMatches(prompt, options?.toolSpecs);
		if (toolMatches.length > 1) {
			yield* this.emitParallelToolCalls(toolMatches, options?.toolSpecs);
			return;
		}
		const toolName = toolMatches[0];
		if (toolName) {
			yield* this.emitToolCall(toolName, options?.toolSpecs);
			return;
		}

		// Default: keyword-based text response

		// Default: keyword-based text response
		yield* this.emitText(matchResponse(prompt));
	}

	/** Emit a text response as ModelStreamEvents. */
	private async *emitText(response: string): AsyncIterable<ModelStreamEvent> {
		yield { type: 'modelMessageStartEvent', role: 'assistant' };
		yield { type: 'modelContentBlockStartEvent' };
		for (const word of response.split(' ')) {
			yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: word + ' ' } };
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
			yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: getToolInput(toolName, toolSpecs) } };
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
		yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: getToolInput(toolName, toolSpecs) } };
		yield { type: 'modelContentBlockStopEvent' };
		yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
		yield { type: 'modelMetadataEvent', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, metrics: { latencyMs: 0 } };
	}
}
