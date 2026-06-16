// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ModelConfig } from './types.js';

/**
 * Pre-configured Bedrock model presets using global inference profiles.
 * Names are capability-based so the underlying model can be upgraded without breaking user code.
 */
export const BedrockModels = {
	/** Great tool use, balanced cost — good middle tier for most workloads. Currently: Claude Sonnet 4.6. */
	BALANCED: {
		provider: 'bedrock',
		modelId: 'global.anthropic.claude-sonnet-4-6',
	},
	/** Highest capability for the hardest tasks. Currently: Claude Opus 4.8. */
	SMART: {
		provider: 'bedrock',
		modelId: 'global.anthropic.claude-opus-4-8',
	},
	/** Lowest latency, still strong capabilities. Currently: Claude Haiku 4.5. */
	FAST: {
		provider: 'bedrock',
		modelId: 'global.anthropic.claude-haiku-4-5',
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
