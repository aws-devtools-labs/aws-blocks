// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ModelConfig } from './types.js';

const BALANCED_MODEL_ID = 'global.anthropic.claude-sonnet-4-6';
const SMART_MODEL_ID = 'global.anthropic.claude-opus-4-8';
const FAST_MODEL_ID = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * Pre-configured Bedrock model presets using global inference profiles.
 * Names are capability-based so the underlying model can be upgraded without breaking user code.
 *
 * **Note:** Global inference profiles route requests to any supported AWS region for
 * optimal throughput. If your workload has data residency requirements, specify a
 * region-scoped inference profile explicitly.
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html
 */
export const BedrockModels = {
	/** Great tool use, balanced cost — good middle tier for most workloads. Currently: Claude Sonnet 4.6. */
	BALANCED: {
		provider: 'bedrock',
		modelId: BALANCED_MODEL_ID,
	},
	/** Highest capability for the hardest tasks. Currently: Claude Opus 4.8. */
	SMART: {
		provider: 'bedrock',
		modelId: SMART_MODEL_ID,
	},
	/** Lowest latency, still strong capabilities. Currently: Claude Haiku 4.5. */
	FAST: {
		provider: 'bedrock',
		modelId: FAST_MODEL_ID,
	},

	/** @deprecated Use `BedrockModels.BALANCED` instead. */
	DEFAULT: {
		provider: 'bedrock',
		modelId: BALANCED_MODEL_ID,
	},
	/** @deprecated Use `BedrockModels.FAST` instead. */
	BUDGET: {
		provider: 'bedrock',
		modelId: FAST_MODEL_ID,
	},
	/** @deprecated Use `BedrockModels.FAST` instead. */
	MICRO: {
		provider: 'bedrock',
		modelId: FAST_MODEL_ID,
	},
} as const satisfies Record<string, ModelConfig>;

/**
 * Pre-configured Ollama model presets for local development.
 * These are convenience shortcuts that use the `openai-api` provider under the hood.
 *
 * **Requirements:**
 * - Ollama must be installed and running (`ollama serve`)
 * - The model must be pulled first (`ollama pull <modelId>`)
 * - Assumes the default Ollama endpoint: `http://localhost:11434/v1`
 *
 * If your Ollama runs on a different port or host, use the `openai-api` provider directly:
 * ```ts
 * { provider: 'openai-api', modelId: 'llama3.1:8b', endpoint: 'http://custom-host:11434/v1', apiKey: 'ollama' }
 * ```
 */
export const OllamaModels = {
	/** Fast and lightweight for quick iteration. Currently: Llama 3.2 3B (~2 GB, needs 4 GB VRAM). */
	XSMALL: {
		provider: 'openai-api',
		modelId: 'llama3.2:3b',
		endpoint: 'http://localhost:11434/v1',
		apiKey: 'ollama',
	},
	/** Good balance of speed and capability. Currently: Llama 3.1 8B (~4.7 GB, needs 8 GB VRAM). */
	SMALL: {
		provider: 'openai-api',
		modelId: 'llama3.1:8b',
		endpoint: 'http://localhost:11434/v1',
		apiKey: 'ollama',
	},
	/** Strong reasoning at moderate size. Currently: DeepSeek R1 14B (~9 GB, needs 16 GB VRAM). */
	MEDIUM: {
		provider: 'openai-api',
		modelId: 'deepseek-r1:14b',
		endpoint: 'http://localhost:11434/v1',
		apiKey: 'ollama',
	},
	/** High quality for complex tasks. Currently: Llama 3.3 70B (~43 GB, needs 48 GB+ VRAM). */
	LARGE: {
		provider: 'openai-api',
		modelId: 'llama3.3:70b',
		endpoint: 'http://localhost:11434/v1',
		apiKey: 'ollama',
	},
	/** Largest local model. Currently: Llama 4 Scout (~67 GB, needs 80 GB+ VRAM). */
	XLARGE: {
		provider: 'openai-api',
		modelId: 'llama4:16x17b',
		endpoint: 'http://localhost:11434/v1',
		apiKey: 'ollama',
	},
} as const satisfies Record<string, ModelConfig>;
