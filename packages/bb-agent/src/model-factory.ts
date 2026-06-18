// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { BedrockModel, type Model } from '@strands-agents/sdk';
import type { BaseModelConfig } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { CannedProvider } from './providers/canned.js';
import { ThrowingProvider } from './providers/throwing.js';
import type { ModelConfig } from './types.js';
import { AgentErrors, blocksAgentError } from './errors.js';

// TODO: validate model-specific inference config (e.g., some models don't support topP with temperature)

/**
 * Checks if a model endpoint is available and the specified model exists.
 * Verifies endpoint/model availability only. Does not guarantee EULA acceptance or feature support (e.g. tool calling).
 * Even calls to verified models can fail at invocation time (e.g. legacy models, quota limits) — always check error logs.
 * For openai-api: pings GET /v1/models and checks if modelId is in the list.
 * For bedrock: verifies model availability via @aws-sdk/client-bedrock (free, no inference cost).
 * For canned: always returns true.
 */
/** @internal Injectable client interface for testing. */
export interface BedrockHealthClient {
	send(command: any): Promise<any>;
}

export async function checkModelHealth(config: ModelConfig, log: ChildLogger, _testClient?: BedrockHealthClient): Promise<boolean> {
	if (!config || config.provider === 'canned') {
		log.info('Using canned provider (local mock, no real model)');
		return true;
	}
	if ((config.provider as string) === 'throwing') {
		log.info('Using throwing provider (test-only)');
		return true;
	}
	log.info(`Checking model health: ${config.provider}${config.modelId ? ` (${config.modelId})` : ''}`);
	if (config.provider === 'bedrock') {
		const getClient = async (): Promise<BedrockHealthClient> => {
			if (_testClient) return _testClient;
			const { BedrockClient } = await import('@aws-sdk/client-bedrock');
			return new BedrockClient({});
		};

		// Try GetInferenceProfile first (covers cross-region and global profiles).
		try {
			const client = await getClient();
			const command = _testClient
				? { inferenceProfileIdentifier: config.modelId }
				: new (await import('@aws-sdk/client-bedrock')).GetInferenceProfileCommand({ inferenceProfileIdentifier: config.modelId });
			const res = await client.send(command);
			if (res.inferenceProfileName) {
				log.info(`Inference profile '${config.modelId}' available`);
				return true;
			}
		} catch (err: unknown) {
			const e = err as { name?: string; message?: string };
			log.debug?.(`Not an inference profile: ${e.name ?? e.message}`, { modelId: config.modelId });
		}

		// Try GetFoundationModel (covers base model IDs).
		try {
			const client = await getClient();
			const command = _testClient
				? { modelIdentifier: config.modelId }
				: new (await import('@aws-sdk/client-bedrock')).GetFoundationModelCommand({ modelIdentifier: config.modelId });
			const res = await client.send(command);
			if (res.modelDetails) {
				log.info(`Bedrock model '${config.modelId}' exists in catalog`);
				return true;
			}
		} catch (err: unknown) {
			const e = err as { name?: string; message?: string };
			log.debug?.(`Not a foundation model: ${e.name ?? e.message}`, { modelId: config.modelId });
		}

		// Both failed — model not found.
		log.warn(`Bedrock model '${config.modelId}' not found as inference profile or foundation model. Verify the model ID and AWS credentials.`, { provider: config.provider, modelId: config.modelId });
		return false;
	}

	if (config.provider === 'openai-api') {
		const endpoint = config.endpoint ?? 'https://api.openai.com/v1';
		const baseUrl = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
		const url = `${baseUrl}/models`;

		const resolvedKey = typeof config.apiKey === 'function'
			? await config.apiKey()
			: config.apiKey ?? process.env.OPENAI_API_KEY;

		// 1. Check if endpoint is reachable
		let res: Response;
		try {
			res = await fetch(url, {
				method: 'GET',
				headers: resolvedKey ? { Authorization: `Bearer ${resolvedKey}` } : {},
				signal: AbortSignal.timeout(3000),
			});
		} catch (err) {
			log.warn(`Endpoint unreachable: ${baseUrl}`, { provider: config.provider, error: (err as Error).message });
			return false;
		}

		if (!res.ok) {
			log.warn(`Endpoint returned HTTP ${res.status}: ${baseUrl}`, { provider: config.provider, status: res.status });
			return false;
		}

		// 2. Endpoint is up — check if specified model exists
		if (!config.modelId) return true;

		// Parse the model list defensively. A 200 response is not a guarantee of a
		// JSON body: misconfigured proxies, captive portals, or a non-OpenAI server
		// sharing the URL can return HTML or plain text. JSON.parse throws on such
		// bodies — if that escaped, it would abort the model fallback loop in
		// createStrandsAgent() and prevent the implicit canned fallback from ever
		// running. Treat an unparseable response as "unhealthy" (return false) so the
		// next candidate is tried, matching the fetch-failure handling above. Read the
		// raw text first so we can log a short snippet of the offending body, which
		// makes a misconfigured proxy / captive portal obvious during debugging.
		let body: { data?: Array<{ id: string }> };
		let text = '';
		try {
			text = await res.text();
		} catch (err) {
			log.warn(`Failed to read model-list response body: ${baseUrl}`, { provider: config.provider, error: (err as Error).message });
			return false;
		}
		try {
			body = JSON.parse(text) as { data?: Array<{ id: string }> };
		} catch (err) {
			log.warn(
				`Endpoint returned a non-JSON body, make sure this is a valid OpenAI-compatible server: ${baseUrl}`,
				{ provider: config.provider, error: (err as Error).message, bodySnippet: text.slice(0, 100) },
			);
			return false;
		}
		const availableModels = body.data?.map(m => m.id) ?? [];

		if (availableModels.includes(config.modelId)) {
			log.info(`Model '${config.modelId}' available at ${baseUrl}`);
			return true;
		}

		// 3. Model not found — log what IS available
		log.warn(`Model '${config.modelId}' not found at ${baseUrl}. Available: ${availableModels.join(', ') || 'none'}`, { provider: config.provider, modelId: config.modelId, availableModels });
		return false;
	}

	return false;
}

/**
 * Maps Blocks' ModelConfig to the corresponding Strands model provider.
 * The developer configures one unified ModelConfig shape — this factory
 * translates it to BedrockModel, OpenAIModel, or CannedProvider internally.
 *
 * @see https://strandsagents.com/docs/user-guide/concepts/model-providers/
 */
export async function createStrandsModel(config?: ModelConfig, log?: ChildLogger): Promise<Model<BaseModelConfig>> {
	if (!config || config.provider === 'canned') return new CannedProvider();

	// Test-only provider — throws mid-stream to verify error handling
	if (config.provider === 'throwing' as string) {
		log?.warn('ThrowingProvider is only for internal test purposes');
		return new ThrowingProvider();
	}

	if (config.provider === 'bedrock') {
		if (!config.modelId) {
			throw blocksAgentError(AgentErrors.InvalidModelConfig, "Model provider 'bedrock' requires modelId.");
		}
		return new BedrockModel({
			modelId: config.modelId,
			...(config.inferenceConfig && {
				temperature: config.inferenceConfig.temperature,
				topP: config.inferenceConfig.topP,
				maxTokens: config.inferenceConfig.maxTokens,
				stopSequences: config.inferenceConfig.stopSequences,
			}),
		});
	}

	if (config.provider === 'openai-api') {
		if (!config.modelId) {
			throw blocksAgentError(AgentErrors.InvalidModelConfig, "Model provider 'openai-api' requires modelId.");
		}
		// Resolve apiKey: string, async function, or env var fallback
		const apiKey = typeof config.apiKey === 'function' ? await config.apiKey() : config.apiKey;
		if (!apiKey && !process.env.OPENAI_API_KEY) {
			throw blocksAgentError(AgentErrors.InvalidModelConfig, "provider 'openai-api' requires apiKey or OPENAI_API_KEY environment variable.");
		}
		return new OpenAIModel({
			api: 'chat',
			apiKey: apiKey ?? '',
			...(config.endpoint && { clientConfig: { baseURL: config.endpoint } }),
			modelId: config.modelId,
			...(config.inferenceConfig && {
				temperature: config.inferenceConfig.temperature,
				topP: config.inferenceConfig.topP,
				maxTokens: config.inferenceConfig.maxTokens,
				...(config.inferenceConfig.stopSequences && {
					params: { stop: config.inferenceConfig.stopSequences },
				}),
			}),
		});
	}

	throw blocksAgentError(AgentErrors.InvalidModelConfig, `Unknown provider: '${config.provider}'.`);
}
