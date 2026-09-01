// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runaway-cap regression tests for the interrupt + resume path: the caps must count
 * across a HITL resume instead of restarting per execution segment, otherwise an
 * auto-approving resume loop re-enters itself and the cap never fires.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { Agent } from './index.mock.js';
import { Scope } from '@aws-blocks/core';

const CANNED = { deployed: { provider: 'canned' as const }, local: { provider: 'canned' as const } };

/** Run one turn, auto-approving every interrupt, until a terminal chunk arrives. */
async function runAutoApproving(agent: any, message: string, conversationId: string, userId: string, maxResumes = 5) {
	const chunks: any[] = [];
	const result = await agent.stream(message, { conversationId, userId });
	const channel = await result.channel;
	const sub = channel.subscribe((chunk: any) => { chunks.push(chunk); });

	const waitFor = async (predicate: () => any) => {
		for (let i = 0; i < 200; i++) {
			const hit = predicate();
			if (hit) return hit;
			await new Promise(r => setTimeout(r, 25));
		}
		return undefined;
	};

	let resumes = 0;
	let terminal = await waitFor(() => chunks.find(c => c.type === 'done' || c.type === 'error' || c.type === 'interrupt'));
	while (terminal?.type === 'interrupt' && resumes < maxResumes) {
		resumes++;
		const seen = chunks.length;
		await agent.resume(result.channelId, terminal.interrupts.map((i: any) => ({ interruptId: i.id, approved: true })), { conversationId, userId });
		terminal = await waitFor(() => chunks.slice(seen).find(c => c.type === 'done' || c.type === 'error' || c.type === 'interrupt'));
	}
	sub.unsubscribe();
	return { chunks, terminal, resumes };
}

describe('cap counting across resume (local verification)', () => {
	test('maxLlmCalls keeps counting after resume() — the pre-resume call still counts', async () => {
		// Segment 1 spends one model call (it emits the toolUse, then needsApproval
		// interrupts). The resumed segment spends one more (the post-tool follow-up), so
		// the turn total is 2. With maxLlmCalls: 1 a per-turn count must trip on that
		// follow-up; with per-segment counters the resumed segment restarts at 0, the
		// follow-up is call #1, and the turn completes — so this discriminates the two.
		const scope = new Scope('verify-cap-resume-llm');
		const agent = new Agent(scope, 'vrl', {
			systemPrompt: 'test',
			maxLlmCalls: 1,
			model: CANNED,
			tools: (tool: any) => ({ getWeather: tool({ description: 'weather', parameters: z.object({ city: z.string() }), needsApproval: true, handler: async () => ({ temp: 22 }) }) }),
		});
		const convId = await agent.createConversationId('u1');
		const { terminal, resumes, chunks } = await runAutoApproving(agent, 'what is the weather?', convId, 'u1');

		assert.strictEqual(resumes, 1, 'the tool should have interrupted once for approval');
		assert.ok(terminal, 'the turn should reach a terminal chunk');
		assert.strictEqual(terminal.type, 'error', `expected the cap to trip after resume, got ${terminal.type}`);
		assert.match(terminal.error, /maxLlmCalls/, 'the error should name the cap that tripped');

		// History must stay paired and explain itself.
		const history = await agent.getConversation(convId);
		const toolCalls = history.filter((m: any) => m.role === 'tool-call');
		const toolResults = history.filter((m: any) => m.role === 'tool-result');
		assert.strictEqual(toolResults.length, toolCalls.length, 'every tool-call needs a matching tool-result');
		assert.ok(history.some((m: any) => m.role === 'assistant' && /maxLlmCalls/.test(JSON.stringify(m.metadata ?? ''))), 'history should record why the turn stopped');
		assert.ok(chunks.some(c => c.type === 'tool-call'), 'sanity: a tool call happened');
	});

	test('an approved tool call is charged once, not twice, across resume()', async () => {
		// The same toolUseId re-emits BeforeToolCallEvent when the turn resumes. With
		// maxToolIterations: 1 a double charge would trip the cap on a single approved
		// call; deduping by toolUseId must let the turn finish.
		const scope = new Scope('verify-cap-resume-dedupe');
		const agent = new Agent(scope, 'vrd', {
			systemPrompt: 'test',
			maxToolIterations: 1,
			model: CANNED,
			tools: (tool: any) => ({ getWeather: tool({ description: 'weather', parameters: z.object({ city: z.string() }), needsApproval: true, handler: async () => ({ temp: 22 }) }) }),
		});
		const convId = await agent.createConversationId('u2');
		const { terminal, resumes } = await runAutoApproving(agent, 'what is the weather?', convId, 'u2');

		assert.strictEqual(resumes, 1, 'the tool should have interrupted once for approval');
		assert.ok(terminal, 'the turn should reach a terminal chunk');
		assert.strictEqual(terminal.type, 'done', `a single approved tool call must not trip maxToolIterations: 1, got ${terminal.type}: ${terminal.error ?? ''}`);
	});
});
