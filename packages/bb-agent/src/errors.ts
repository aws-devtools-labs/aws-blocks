// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { blocksError as coreBlocksError, brandBlocksError, isBlocksError, isWireSafeError } from '@aws-blocks/core';

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
	/** The conversation does not exist or does not belong to the calling user. */
	ConversationNotFound: 'ConversationNotFoundException',
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

/** Maximum number of levels (the error itself plus its causes) {@link walkCauseChain} visits. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Bounded, cycle-safe walk of `err` and its `.cause` chain, returning each level outermost first.
 *
 * `.cause` is often non-enumerable and may wrap several levels (e.g. a Strands wrapper over the raw
 * AWS SDK error), so it is read explicitly. The walk stops after {@link MAX_CAUSE_DEPTH} levels, at
 * the first `null`/`undefined` or non-object level (a string or other primitive cause is still
 * returned as the last level), and at the first level already visited, so a self-referencing or
 * cyclic chain terminates.
 *
 * @internal Shared by the error classifier and diagnostic logging; not customer API.
 */
export function walkCauseChain(err: unknown): unknown[] {
	const levels: unknown[] = [];
	const seen = new Set<unknown>();
	let current: unknown = err;
	while (current !== null && current !== undefined && levels.length < MAX_CAUSE_DEPTH && !seen.has(current)) {
		levels.push(current);
		if (typeof current !== 'object') break;
		seen.add(current);
		current = 'cause' in current ? current.cause : undefined;
	}
	return levels;
}

/**
 * Bounded walk of `err` and its `.cause` chain, yielding each level's `name`, `message`, and the AWS
 * SDK `$metadata.httpStatusCode` where present.
 */
function collectErrorText(err: unknown): { names: string[]; messages: string[]; httpStatusCodes: number[] } {
	const names: string[] = [];
	const messages: string[] = [];
	const httpStatusCodes: number[] = [];
	for (const level of walkCauseChain(err)) {
		if (typeof level === 'string') {
			messages.push(level);
			continue;
		}
		if (typeof level !== 'object' || level === null) continue;
		if ('name' in level && typeof level.name === 'string') names.push(level.name);
		if ('message' in level && typeof level.message === 'string') messages.push(level.message);
		if ('$metadata' in level && level.$metadata !== null && typeof level.$metadata === 'object') {
			const metadata = level.$metadata;
			if ('httpStatusCode' in metadata && typeof metadata.httpStatusCode === 'number') httpStatusCodes.push(metadata.httpStatusCode);
		}
	}
	return { names, messages, httpStatusCodes };
}

/**
 * The model id as it may appear in a client-facing message. An ARN carries the account id, so only
 * the resource name after its last `/` (the model or inference profile id) is shown.
 */
function displayModelId(modelId: string): string {
	return modelId.startsWith('arn:') ? modelId.slice(modelId.lastIndexOf('/') + 1) : modelId;
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
 * Walks `err` and its `.cause` chain. Nothing is classified unless some level is a Bedrock access
 * refusal — `name` is `AccessDeniedException` or `$metadata.httpStatusCode` is `403` — so the same
 * wording under another error (a validation error, a plain `Error`) is left unclassified; the message
 * text only selects which refusal it is. The returned message is composed here and never echoes the
 * raw provider error or its metadata, so it is safe to publish to the client.
 *
 * @param err - the error thrown by the agent loop.
 * @param modelId - the Bedrock model or inference profile id, named in the message when known. For an
 * ARN only the part after its last `/` is named, so the account id is not published.
 * @returns an actionable message, or `undefined` when `err` is not a recognised model-access failure.
 */
export function classifyModelAccessError(err: unknown, modelId?: string): string | undefined {
	const { names, messages, httpStatusCodes } = collectErrorText(err);
	if (!names.includes('AccessDeniedException') && !httpStatusCodes.includes(403)) return undefined;
	const text = messages.join('\n');
	const named = modelId ? `Bedrock model '${displayModelId(modelId)}'` : undefined;
	const subject = named ?? 'The selected Bedrock model';

	if (/use case details have not been submitted|anthropic use case details form/i.test(text)) {
		return `${subject} requires Anthropic use case details for this AWS account. Submit the one-time Anthropic first-time-use form from the model catalog in the Amazon Bedrock console (or call the PutUseCaseForModelAccess API), then retry; access can take several minutes to become active after submission (GetFoundationModelAvailability reports its status). In opt-in Regions the form must be submitted again. Submitting once from an AWS Organizations management account covers its member accounts. Models from other providers do not require this form.`;
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
	if (/(?:don't|do not) have access to the model|model access is denied|access to the model/i.test(text)) {
		return `Access to ${named ?? 'the selected Bedrock model'} was denied for this AWS account. For an Anthropic model, submit the one-time Anthropic first-time-use form from the model catalog in the Amazon Bedrock console (or call the PutUseCaseForModelAccess API); otherwise confirm the model is available to the account in this Region (GetFoundationModelAvailability reports its status), or choose a different model.`;
	}
	return undefined;
}

/**
 * The client-facing message of a `ModelUnavailable` error the Agent BB raised itself (for example,
 * when no configured model passes the health check), without its leading `ModelUnavailableException: `
 * prefix — {@link agentErrorFromChunk} adds that prefix back when the client rebuilds the error, so the
 * name appears exactly once end to end.
 *
 * Only a branded (wire-safe) error qualifies: its message is composed by the Agent BB, so it is safe
 * to publish. A raw error that merely carries the same `name` is not trusted.
 *
 * @returns the message to publish, or `undefined` when `err` is not a branded `ModelUnavailable`.
 */
export function brandedModelUnavailableMessage(err: unknown): string | undefined {
	if (!isBlocksError(err, AgentErrors.ModelUnavailable) || !isWireSafeError(err)) return undefined;
	const prefix = `${AgentErrors.ModelUnavailable}: `;
	return err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message;
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
