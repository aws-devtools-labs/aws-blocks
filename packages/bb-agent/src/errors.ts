// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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
} as const;

export function blocksAgentError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

export class InterruptError extends Error {
	readonly interrupts: Array<{ id: string; name: string; reason?: any }>;

	constructor(message: string, interrupts: Array<{ id: string; name: string; reason?: any }>) {
		super(`${AgentErrors.InterruptRequired}: ${message}`);
		this.name = AgentErrors.InterruptRequired;
		this.interrupts = interrupts;
	}
}
