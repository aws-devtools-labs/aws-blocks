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
 *   await agent.getConversation(id, userId);
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
	/** A usage precondition was violated (e.g. subscribe() with no channel, or a server method called without the caller's userId). */
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

export class InterruptError extends Error {
	readonly interrupts: Array<{ id: string; name: string; reason?: any }>;

	constructor(message: string, interrupts: Array<{ id: string; name: string; reason?: any }>) {
		super(`${AgentErrors.InterruptRequired}: ${message}`);
		this.name = AgentErrors.InterruptRequired;
		this.interrupts = interrupts;
		brandBlocksError(this);
	}
}
