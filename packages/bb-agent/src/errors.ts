// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { blocksError as coreBlocksError, brandBlocksError } from '@aws-blocks/core';

/**
 * Typed error constants for Agent BB. Use with `isBlocksError()` in catch blocks.
 *
 * @example
 * ```typescript
 * import { isBlocksError } from '@aws-blocks/core';
 * import { AgentErrors } from '@aws-blocks/bb-agent';
 *
 * try {
 *   await agent.getConversation(id);
 * } catch (e) {
 *   if (isBlocksError(e, AgentErrors.PersistenceRequired)) {
 *     // agent is in inferenceOnly mode
 *   }
 * }
 * ```
 */
export const AgentErrors = {
	PersistenceRequired: 'PersistenceRequiredException',
	InvalidModelConfig: 'InvalidModelConfigException',
	ModelUnavailable: 'ModelUnavailableException',
	BrowserNotSupported: 'BrowserNotSupportedException',
	StreamFailed: 'StreamFailedException',
	InterruptRequired: 'InterruptRequiredException',
	/** A client-side usage precondition was violated (e.g. subscribe() with no channel). */
	InvalidUsage: 'InvalidUsageException',
} as const;

/** One of the `name` values in {@link AgentErrors}. */
export type AgentErrorName = (typeof AgentErrors)[keyof typeof AgentErrors];

/**
 * Build a typed `Error` whose `name` is one of {@link AgentErrors}, so it crosses
 * the RPC wire by `name` and is matchable with `isBlocksError()`.
 *
 * A thin typed wrapper over core's `blocksError` — it narrows `name` to an
 * {@link AgentErrorName} so call sites are checked, while the error minting
 * (prefixing, naming, wire-safe branding) stays in one place in core.
 */
export function blocksAgentError(name: AgentErrorName, message: string): Error {
	return coreBlocksError(name, message);
}

/**
 * Map a published `error` chunk to the branded error a client rejects or reports with.
 *
 * The chunk's optional `errorName` carries the server-side classification across the
 * Realtime wire. Only names the server deliberately emits are honoured; an absent or
 * unrecognised value falls back to {@link AgentErrors.StreamFailed}, so chunks from an
 * older server (no `errorName`) keep their original behaviour.
 */
export function agentErrorFromChunk(chunk: { error?: string; errorName?: string }): Error {
	const name: AgentErrorName =
		chunk.errorName === AgentErrors.ModelUnavailable ? AgentErrors.ModelUnavailable : AgentErrors.StreamFailed;
	return blocksAgentError(name, chunk.error ?? 'Agent error');
}

/** Bounded walk of `err` and its `.cause` chain, yielding each level's `name` and `message`. */
function collectErrorText(err: unknown): { names: string[]; messages: string[] } {
	const names: string[] = [];
	const messages: string[] = [];
	let current: unknown = err;
	// `.cause` is often non-enumerable and may wrap several levels (e.g. a Strands wrapper over
	// the raw AWS SDK error), so read it explicitly. The depth bound guards against cycles.
	for (let depth = 0; current !== null && current !== undefined && depth < 5; depth++) {
		if (typeof current === 'string') {
			messages.push(current);
			break;
		}
		if (typeof current !== 'object') break;
		if ('name' in current && typeof current.name === 'string') names.push(current.name);
		if ('message' in current && typeof current.message === 'string') messages.push(current.message);
		current = 'cause' in current ? current.cause : undefined;
	}
	return { names, messages };
}

/**
 * Recognise a Bedrock invoke-time model-access failure and compose an actionable message for it.
 *
 * A model can pass the health check (the inference profile exists) and still be refused when it is
 * invoked, for account-level reasons the agent's Bedrock invoke permissions do not cover:
 * - Anthropic models require a one-time, per-account use-case-details (first-time-use) submission.
 * - Models sold through AWS Marketplace (including Anthropic models) are activated for an account the
 *   first time they are invoked by a principal with the `aws-marketplace:Subscribe`,
 *   `aws-marketplace:Unsubscribe` and `aws-marketplace:ViewSubscriptions` permissions; until then
 *   Bedrock reports that the required AWS Marketplace actions are not authorized.
 * - Some models are not entitled for every account ("is not available for this account").
 * - Bedrock reports a model-access `AccessDeniedException` for a model the account cannot use.
 *
 * Walks `err` and its `.cause` chain, matching on names and messages only. The returned message is
 * composed here and never echoes the raw provider error or its metadata, so it is safe to publish to
 * the client.
 *
 * @param err - the error thrown by the agent loop.
 * @param modelId - the Bedrock model or inference profile id, named in the message when known.
 * @returns an actionable message, or `undefined` when `err` is not a recognised model-access failure.
 */
export function classifyModelAccessError(err: unknown, modelId?: string): string | undefined {
	const { names, messages } = collectErrorText(err);
	const text = messages.join('\n');
	const named = modelId ? `Bedrock model '${modelId}'` : undefined;
	const subject = named ?? 'The selected Bedrock model';

	if (/use case details have not been submitted|anthropic use case details form/i.test(text)) {
		return `${subject} requires Anthropic use case details for this AWS account. Submit the one-time Anthropic first-time-use form from the model catalog in the Amazon Bedrock console (or call the PutUseCaseForModelAccess API), then retry; access can take several minutes to become active after submission (GetFoundationModelAvailability reports its status). Submitting once from an AWS Organizations management account covers its member accounts. Models from other providers do not require this form.`;
	}
	// Checked before the entitlement branch: Bedrock's Marketplace refusal can also say the model
	// "is not available for this account", but its fix is a one-time subscription, not a new model.
	if (/AWS Marketplace actions/i.test(text)) {
		return `${subject} has not had its one-time AWS Marketplace subscription activated for this AWS account. Invoke the model once (for example, from the Amazon Bedrock console playground) as a principal with the aws-marketplace:Subscribe, aws-marketplace:Unsubscribe and aws-marketplace:ViewSubscriptions permissions, then retry. This is needed once per account.`;
	}
	if (/is not available for this account/i.test(text)) {
		return `${subject} is not available for this AWS account. Choose a different model or preset (for example, a model from another provider), or contact AWS to make this model available to the account.`;
	}
	// Match Bedrock's model-access wording specifically, so an IAM denial on an unrelated action
	// that merely mentions a "model" is not reported as a model-access refusal.
	if (names.includes('AccessDeniedException') && /(?:don't|do not) have access to the model|model access is denied|access to the model/i.test(text)) {
		return `Access to ${named ?? 'the selected Bedrock model'} was denied for this AWS account. For an Anthropic model, submit the one-time Anthropic first-time-use form from the model catalog in the Amazon Bedrock console (or call the PutUseCaseForModelAccess API); otherwise confirm the model is available to the account in this Region (GetFoundationModelAvailability reports its status), or choose a different model.`;
	}
	return undefined;
}

export class InterruptError extends Error {
	readonly interrupts: Array<{ id: string; name: string; reason?: any }>;

	constructor(message: string, interrupts: Array<{ id: string; name: string; reason?: any }>) {
		super(`${AgentErrors.InterruptRequired}: ${message}`);
		this.name = AgentErrors.InterruptRequired;
		this.interrupts = interrupts;
		brandBlocksError(this);
	}
}
