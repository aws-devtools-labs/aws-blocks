// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runaway-cap regression test for turn boundaries: the per-turn counters live in the
 * session-persisted `appState`, so a new message must start a fresh budget rather than
 * inheriting the previous turn's count.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { Agent } from './index.mock.js';
import { Scope } from '@aws-blocks/core';

const CANNED = { deployed: { provider: 'canned' as const }, local: { provider: 'canned' as const } };

describe('cap counters across separate turns (local probe)', () => {
	test('a second message on the same conversation gets a fresh budget', async () => {
		// Each tool turn spends 2 model calls. With maxLlmCalls: 2 every turn must
		// complete on its own budget. If the counters leak across turns (the session
		// snapshot restoring the previous turn's count over runAgent's reset), turn 2
		// trips immediately even though it is a brand-new message.
		const scope = new Scope('probe-cap-turns');
		const agent = new Agent(scope, 'pct', {
			systemPrompt: 'test',
			maxLlmCalls: 2,
			model: CANNED,
			tools: (tool: any) => ({ getWeather: tool({ description: 'weather', parameters: z.object({ city: z.string() }), handler: async () => ({ temp: 22 }) }) }),
		});
		const convId = await agent.createConversationId('u1');

		const first = await (await agent.stream('what is the weather?', { conversationId: convId, userId: 'u1' })).complete();
		assert.strictEqual(first.type, 'done', 'turn 1 should complete');

		const second = await agent.stream('what is the weather?', { conversationId: convId, userId: 'u1' });
		const chunks: any[] = [];
		const ch = await second.channel;
		const sub = ch.subscribe((c: any) => chunks.push(c));
		let terminal: any;
		for (let i = 0; i < 200 && !terminal; i++) {
			terminal = chunks.find(c => c.type === 'done' || c.type === 'error' || c.type === 'interrupt');
			if (!terminal) await new Promise(r => setTimeout(r, 25));
		}
		sub.unsubscribe();
		assert.ok(terminal, 'turn 2 should reach a terminal chunk');
		assert.strictEqual(terminal.type, 'done', `turn 2 must get a fresh budget, got ${terminal.type}: ${terminal.error ?? ''}`);
	});
});
