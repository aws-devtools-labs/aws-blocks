// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ThrowingProvider — extends CannedProvider but throws mid-stream.
 * Used in unit tests to verify block buffer flush on error.
 */
import { CannedProvider } from './canned.js';
import type { Message, ModelStreamEvent, StreamOptions } from '@strands-agents/sdk';

/**
 * When the latest message contains this text, the provider instead fails the way Bedrock does
 * for an account that has not submitted Anthropic use-case details: a wrapper error whose
 * non-enumerable `.cause` is the raw `AccessDeniedException`.
 */
export const SIMULATE_MODEL_ACCESS_DENIED = '[simulate-model-access-denied]';

export class ThrowingProvider extends CannedProvider {
	async *stream(messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
		const last = messages[messages.length - 1];
		const lastText = (last?.content ?? [])
			.map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
			.join(' ');
		if (lastText.includes(SIMULATE_MODEL_ACCESS_DENIED)) {
			const cause = new Error(
				'Model use case details have not been submitted for this account. Fill out the Anthropic use case details form before using the model. If you have already filled out the form, try again in 15 minutes.',
			);
			cause.name = 'AccessDeniedException';
			throw new Error('Model stream failed', { cause });
		}
		yield { type: 'modelMessageStartEvent', role: 'assistant' };
		yield { type: 'modelContentBlockStartEvent' };
		yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'partial ' } };
		yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'text' } };
		throw new Error('simulated mid-stream failure');
	}
}
