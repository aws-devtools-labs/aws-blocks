// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { Scope } from '@aws-blocks/core';
import { z } from 'zod';
import { Agent, AgentErrors, BedrockModels, OllamaModels } from './index.mock.js';
import { checkModelHealth, createStrandsModel } from './model-factory.js';
import { CannedProvider } from './providers/canned.js';
import type { AgentStreamChunk } from './types.js';

/** Drain an agent SSE generator into an array of chunks (test helper). */
async function drain(gen: AsyncGenerator<AgentStreamChunk>): Promise<AgentStreamChunk[]> {
	const chunks: AgentStreamChunk[] = [];
	for await (const c of gen) chunks.push(c);
	return chunks;
}

// ── AgentErrors ─────────────────────────────────────────────────────────────

describe('AgentErrors', () => {
	test('has expected error names', () => {
		assert.strictEqual(AgentErrors.PersistenceRequired, 'PersistenceRequiredException');
		assert.strictEqual(AgentErrors.InvalidModelConfig, 'InvalidModelConfigException');
		assert.strictEqual(AgentErrors.BrowserNotSupported, 'BrowserNotSupportedException');
	});
});

// ── createConversationId ────────────────────────────────────────────────────

describe('createConversationId', () => {
	test('returns a valid UUID', async () => {
		const scope = new Scope('test-uuid');
		const agent = new Agent(scope, 'a', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
		});
		const id = await agent.createConversationId('test-user');
		assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	test('returns unique IDs', async () => {
		const scope = new Scope('test-uuid2');
		const agent = new Agent(scope, 'b', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
		});
		const id1 = await agent.createConversationId('test-user');
		const id2 = await agent.createConversationId('test-user');
		assert.notStrictEqual(id1, id2);
	});
});

// ── mutual exclusivity: needsApproval + interrupt ──────────────────────────

describe('needsApproval and interrupt mutual exclusivity', () => {
	test('throws when both needsApproval and interrupt are specified', async () => {
		const scope = new Scope('test-mutex');
		const agent = new Agent(scope, 'mx', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			tools: (tool) => ({
				badTool: tool({
					description: 'has both',
					parameters: z.object({}),
					needsApproval: true,
					interrupt: () => {},
					handler: async () => ({}),
				}),
			}),
		});
		await assert.rejects(
			() => drain(agent.streamSSE('hello', { userId: 'test-user' })),
			(err: any) => {
				assert.ok(err.message.includes("'needsApproval' or 'trustable' alongside 'interrupt'"));
				assert.ok(err.message.includes('badTool'));
				return true;
			},
		);
	});

	test('throws when trustable and interrupt are specified', async () => {
		const scope = new Scope('test-mutex2');
		const agent = new Agent(scope, 'mx2', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			tools: (tool) => ({
				badTool2: tool({
					description: 'has trustable + interrupt',
					parameters: z.object({}),
					trustable: true,
					interrupt: () => {},
					handler: async () => ({}),
				}),
			}),
		});
		await assert.rejects(
			() => drain(agent.streamSSE('hello', { userId: 'test-user' })),
			(err: any) => {
				assert.ok(err.message.includes("'needsApproval' or 'trustable' alongside 'interrupt'"));
				assert.ok(err.message.includes('badTool2'));
				return true;
			},
		);
	});

	test('needsApproval alone works', async () => {
		const scope = new Scope('test-appr');
		const agent = new Agent(scope, 'ap', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			tools: (tool) => ({
				approvalTool: tool({
					description: 'approval only',
					parameters: z.object({}),
					needsApproval: false,
					handler: async () => ({ ok: true }),
				}),
			}),
		});
		const chunks = await drain(agent.streamSSE('hello', { userId: 'test-user' }));
		assert.ok(chunks.some((c) => c.type === 'done'));
	});

	test('interrupt alone works', async () => {
		const scope = new Scope('test-intr');
		const agent = new Agent(scope, 'it', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			tools: (tool) => ({
				interruptTool: tool({
					description: 'interrupt only',
					parameters: z.object({}),
					interrupt: () => {},
					handler: async () => ({ ok: true }),
				}),
			}),
		});
		const chunks = await drain(agent.streamSSE('hello', { userId: 'test-user' }));
		assert.ok(chunks.some((c) => c.type === 'done'));
	});
});

// ── streamSSE() ──────────────────────────────────────────────────────────────

describe('streamSSE()', () => {
	test('yields a done chunk for a simple turn (inferenceOnly, no persistence)', async () => {
		const scope = new Scope('test-sse');
		const agent = new Agent(scope, 'sse', {
			systemPrompt: 'test',
			inferenceOnly: true,
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
		});
		const chunks = await drain(agent.streamSSE('hello'));
		assert.ok(
			chunks.some((c) => c.type === 'done'),
			'should yield a done chunk',
		);
	});

	test('requires userId when persistence is enabled', async () => {
		const scope = new Scope('test-sse-uid');
		const agent = new Agent(scope, 'su', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
		});
		await assert.rejects(
			() => drain(agent.streamSSE('hello')),
			(err: any) => err.name === AgentErrors.PersistenceRequired,
		);
	});
});

// ── tool factory enforcement (compile-time) ──────────────────────────────────

describe('tool factory enforcement', () => {
	// Regression: AgentConfig.tools is a callback `(tool) => Record<string, AgentTool>`.
	// A plain object literal in the Record is missing the unforgeable brand and must be
	// a compile error — this is what forces every tool through the `tool()` factory
	// (which recovers precise `input` typing). The @ts-expect-error below fails the
	// build if a raw object literal ever becomes assignable again.
	test('a plain object literal is rejected by the tools type', () => {
		const scope = new Scope('test-tool-brand');
		const agent = new Agent(scope, 'tb', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			// @ts-expect-error a plain object is not an AgentTool — must use the tool() factory
			tools: () => ({
				raw: { description: 'raw literal', parameters: z.object({}), handler: async () => ({}) },
			}),
		});
		assert.ok(agent);
	});

	test('a tool created with the factory is accepted', () => {
		const scope = new Scope('test-tool-brand2');
		const agent = new Agent(scope, 'tb2', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			tools: (tool) => ({
				ok: tool({ description: 'wrapped', parameters: z.object({}), handler: async () => ({}) }),
			}),
		});
		assert.ok(agent);
	});
});

// ── AgentConfig name/description forwarding ──────────────────────────────────

describe('AgentConfig name/description forwarding', () => {
	// Regression: AgentConfig.name/description are public options and Strands' Agent
	// constructor supports them, but they were never passed through, so setting them
	// had no effect. They must reach the underlying Strands agent. createStrandsAgent
	// is private — reach it via a cast to inspect the constructed agent.
	test('name and description are forwarded to the Strands agent', async () => {
		const scope = new Scope('test-name-desc');
		const agent = new Agent(scope, 'nd', {
			systemPrompt: 'test',
			name: 'researcher',
			description: 'Finds information',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
		});
		const strands = await (agent as any).createStrandsAgent('conv-nd');
		assert.strictEqual(strands.name, 'researcher', 'AgentConfig.name should reach Strands');
		assert.strictEqual(strands.description, 'Finds information', 'AgentConfig.description should reach Strands');
	});

	// When unset, we must NOT pass undefined — Strands keeps its own default name.
	test('omitting name/description leaves the Strands default intact', async () => {
		const scope = new Scope('test-name-desc2');
		const agent = new Agent(scope, 'nd2', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
		});
		const strands = await (agent as any).createStrandsAgent('conv-nd2');
		// Strands assigns a non-empty default name when none is provided.
		assert.ok(typeof strands.name === 'string' && strands.name.length > 0, 'Strands should keep a default name');
	});
});

// ── inferenceOnly error handling ────────────────────────────────────────────

describe('inferenceOnly error handling', () => {
	const scope = new Scope('test-io');
	const agent = new Agent(scope, 'io', {
		inferenceOnly: true,
		systemPrompt: 'test',
		model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
	});

	test('getConversation throws PersistenceRequired', async () => {
		await assert.rejects(
			() => agent.getConversation('any-id'),
			(err: any) => err.name === AgentErrors.PersistenceRequired,
		);
	});

	test('deleteConversation throws PersistenceRequired', async () => {
		await assert.rejects(
			() => agent.deleteConversation('any-id', 'test-user'),
			(err: any) => err.name === AgentErrors.PersistenceRequired,
		);
	});

	test('stream still works', async () => {
		const chunks = await drain(agent.streamSSE('hello', { userId: 'test-user' }));
		assert.ok(chunks.some((c) => c.type === 'done'));
	});

	// (removed: resume() replaced by streamSSE interruptResponses; conversationId guard no longer applies)
});

// ── deleteConversation ownership scoping ─────────────────────────────────────

describe('deleteConversation ownership scoping', () => {
	// Regression: deleteConversation(id, userId) must be owner-scoped. The messages
	// table is partitioned by conversationId (not userId) and the session snapshot
	// is keyed by sessionId alone, so those deletes are not user-scoped on their
	// own. Only the conversation record is keyed by { userId, conversationId } — a
	// non-owner delete of it silently no-ops. Previously a non-owner caller wiped
	// the owner's entire message history + session while the owner's conversation
	// record survived. A non-owner call must now be a no-op for the owner's data.
	test("does not delete another user's messages when userId does not match", async () => {
		const scope = new Scope('test-del-owner');
		const agent = new Agent(scope, 'do', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
		});

		const ownerId = 'owner-1';
		const convId = await agent.createConversationId(ownerId);
		await drain(agent.streamSSE('hello', { conversationId: convId, userId: ownerId }));

		const before = await agent.getConversation(convId);
		assert.ok(before.length > 0, 'owner should have messages before delete');

		// A different (non-owner) user attempts to delete this conversation.
		await agent.deleteConversation(convId, 'attacker-2');

		// The owner's messages must survive a non-owner delete.
		const after = await agent.getConversation(convId);
		assert.ok(after.length > 0, 'owner messages must not be deleted by a non-owner caller');
	});

	test('owner can still delete their own conversation', async () => {
		const scope = new Scope('test-del-owner2');
		const agent = new Agent(scope, 'do2', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
		});

		const ownerId = 'owner-1';
		const convId = await agent.createConversationId(ownerId);
		await drain(agent.streamSSE('hello', { conversationId: convId, userId: ownerId }));
		assert.ok((await agent.getConversation(convId)).length > 0);

		await agent.deleteConversation(convId, ownerId);

		const after = await agent.getConversation(convId);
		assert.strictEqual(after.length, 0, 'owner delete should remove all messages');
	});
});

// ── CannedProvider ──────────────────────────────────────────────────────────

describe('CannedProvider', () => {
	test('returns default response for unknown prompt', async () => {
		const provider = new CannedProvider();
		const chunks: string[] = [];
		for await (const event of provider.stream([{ role: 'user', content: [{ text: 'random input' }] }] as any)) {
			if (event.type === 'modelContentBlockDeltaEvent' && event.delta.type === 'textDelta') {
				chunks.push(event.delta.text);
			}
		}
		const text = chunks.join('');
		assert.ok(text.includes('canned'), 'should contain canned marker');
	});

	test('returns keyword response for weather', async () => {
		const provider = new CannedProvider();
		const chunks: string[] = [];
		for await (const event of provider.stream([
			{ role: 'user', content: [{ text: 'tell me about the weather' }] },
		] as any)) {
			if (event.type === 'modelContentBlockDeltaEvent' && event.delta.type === 'textDelta') {
				chunks.push(event.delta.text);
			}
		}
		const text = chunks.join('');
		assert.ok(text.includes('22°C'), 'should contain weather data');
	});

	test('triggers tool call when prompt matches tool name', async () => {
		const provider = new CannedProvider();
		let toolName: string | undefined;
		const toolSpecs = [{ name: 'getWeather', description: 'Get weather', inputSchema: {} }];
		for await (const event of provider.stream(
			[{ role: 'user', content: [{ text: 'what is the weather today' }] }] as any,
			{ toolSpecs } as any,
		)) {
			if (event.type === 'modelContentBlockStartEvent' && event.start?.type === 'toolUseStart') {
				toolName = event.start.name;
			}
		}
		assert.strictEqual(toolName, 'getWeather');
	});

	// Regression: tool matching must respect word boundaries. Previously the matcher
	// used substring `includes()`, so a camelCase tool word would trigger on any
	// longer word that merely contained it — e.g. "category" triggered `getCat`,
	// "password" triggered `getPass`, and "in order to" triggered `getOrder`. These
	// must NOT trigger a tool call now.
	test('does not trigger a tool when a tool word is only a substring of an unrelated word', async () => {
		const provider = new CannedProvider();
		const cases: Array<{ prompt: string; tool: string }> = [
			{ prompt: 'what is the category of this item', tool: 'getCat' },
			{ prompt: 'I forgot my password', tool: 'getPass' },
			{ prompt: 'please reorder the list alphabetically', tool: 'getOrder' },
		];
		for (const { prompt, tool } of cases) {
			const toolSpecs = [{ name: tool, description: '', inputSchema: {} }];
			const started: string[] = [];
			for await (const event of provider.stream(
				[{ role: 'user', content: [{ text: prompt }] }] as any,
				{ toolSpecs } as any,
			)) {
				if (event.type === 'modelContentBlockStartEvent' && event.start?.type === 'toolUseStart')
					started.push(event.start.name);
			}
			assert.deepStrictEqual(started, [], `prompt "${prompt}" must not trigger ${tool}`);
		}
	});

	// Genuine whole-word mentions must still trigger (documented mock behavior).
	test('still triggers a tool when a camelCase word appears as a whole word', async () => {
		const provider = new CannedProvider();
		const toolSpecs = [{ name: 'getOrder', description: '', inputSchema: {} }];
		const started: string[] = [];
		for await (const event of provider.stream(
			[{ role: 'user', content: [{ text: 'what is the status of my order' }] }] as any,
			{ toolSpecs } as any,
		)) {
			if (event.type === 'modelContentBlockStartEvent' && event.start?.type === 'toolUseStart')
				started.push(event.start.name);
		}
		assert.deepStrictEqual(started, ['getOrder']);
	});

	test('responds to tool result with acknowledgment', async () => {
		const provider = new CannedProvider();
		const chunks: string[] = [];
		for await (const event of provider.stream([
			{ role: 'user', content: [{ toolResult: { toolUseId: 'test', content: [{ text: 'result' }] } }] },
		] as any)) {
			if (event.type === 'modelContentBlockDeltaEvent' && event.delta.type === 'textDelta') {
				chunks.push(event.delta.text);
			}
		}
		const text = chunks.join('');
		assert.ok(text.includes('called the tool'), 'should contain tool response marker');
	});

	test('emits modelMetadataEvent with zero usage', async () => {
		const provider = new CannedProvider();
		let usage: any;
		for await (const event of provider.stream([{ role: 'user', content: [{ text: 'hi' }] }] as any)) {
			if (event.type === 'modelMetadataEvent') usage = event.usage;
		}
		assert.strictEqual(usage.inputTokens, 0);
		assert.strictEqual(usage.outputTokens, 0);
	});

	test('test canned provider', async () => {
		const scope = new Scope('test-canned');
		const agent = new Agent(scope, 'canned', {
			inferenceOnly: false,
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
		});
		const chunks = await drain(agent.streamSSE('hello', { userId: 'test-user' }));
		const done = chunks.find((c) => c.type === 'done');
		assert.ok(done, 'should yield a done chunk');
		assert.ok(done.text && done.text.length > 0, 'should have response text');
	});

	test('getConversation with limit returns most recent messages', async () => {
		const scope = new Scope('test-limit');
		const agent = new Agent(scope, 'lim', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
		});
		const convId = await agent.createConversationId('test-user');
		// Send 3 messages to create at least 6 entries (user + assistant each)
		for (const msg of ['first', 'second', 'third']) {
			await drain(agent.streamSSE(msg, { conversationId: convId, userId: 'test-user' }));
		}
		const all = await agent.getConversation(convId);
		const limited = await agent.getConversation(convId, { limit: 2 });
		assert.ok(all.length >= 6, 'should have at least 6 messages');
		assert.strictEqual(limited.length, 2, 'limit should cap results');
		// Limited should return the most recent messages
		assert.strictEqual(limited[1].messageId, all[all.length - 1].messageId, 'last message should match');
	});

	// Regression: limit: 0 means "zero messages", and a negative limit is likewise
	// not "unlimited". Previously the `options?.limit &&` guard treated 0 as falsy
	// and negatives fell through (result.length >= negative is never true), so ALL
	// messages were returned in both cases. Any limit <= 0 must return an empty array.
	test('getConversation with limit 0 or negative returns no messages', async () => {
		const scope = new Scope('test-limit-zero');
		const agent = new Agent(scope, 'lim0', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
		});
		const convId = await agent.createConversationId('test-user');
		for (const msg of ['first', 'second']) {
			await drain(agent.streamSSE(msg, { conversationId: convId, userId: 'test-user' }));
		}
		assert.ok((await agent.getConversation(convId)).length > 0, 'sanity: conversation has messages');
		assert.strictEqual(
			(await agent.getConversation(convId, { limit: 0 })).length,
			0,
			'limit 0 should return an empty array, not all messages',
		);
		assert.strictEqual(
			(await agent.getConversation(convId, { limit: -1 })).length,
			0,
			'negative limit should return an empty array, not all messages',
		);
	});

	test('token mode publishes multiple chunks', async () => {
		const scope = new Scope('test-token');
		const agent = new Agent(scope, 'tok', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			streamingMode: 'token',
		});
		const chunks = await drain(agent.streamSSE('hello', { userId: 'test-user' }));
		const textChunks = chunks.filter((c) => c.type === 'text-delta');
		assert.ok(textChunks.length > 1, 'token mode should produce multiple text-delta chunks');
	});

	test('block mode publishes fewer chunks than token mode', async () => {
		const scope = new Scope('test-block');
		const agent = new Agent(scope, 'blk', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			streamingMode: 'block',
		});
		const chunks = await drain(agent.streamSSE('hello', { userId: 'test-user' }));
		const textChunks = chunks.filter((c) => c.type === 'text-delta');
		assert.ok(textChunks.length === 1, 'block mode should produce a single text-delta chunk with full content');
		assert.ok(textChunks[0].text && textChunks[0].text.length > 0, 'block chunk should have content');
	});

	test('block mode flushes partial buffer on stream error', async () => {
		const scope = new Scope('test-block-err');
		const agent = new Agent(scope, 'blkerr', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'throwing' as any }, local: { provider: 'throwing' as any } },
			streamingMode: 'block',
		});
		const chunks = await drain(agent.streamSSE('hello', { userId: 'test-user' }));
		const textChunks = chunks.filter((c) => c.type === 'text-delta');
		const errorChunk = chunks.find((c) => c.type === 'error');
		assert.ok(textChunks.length > 0, 'should flush partial block buffer before error');
		assert.strictEqual(textChunks[0].text, 'partial text', 'flushed text should contain buffered content');
		assert.ok(errorChunk, 'should receive an error chunk after buffer flush');
	});

	test('surfaces an error chunk on a mid-stream provider failure', async () => {
		const scope = new Scope('test-complete-err');
		const agent = new Agent(scope, 'cerr', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'throwing' as any }, local: { provider: 'throwing' as any } },
		});
		const chunks = await drain(agent.streamSSE('hello', { userId: 'test-user' }));
		const errChunk = chunks.find((c) => c.type === 'error');
		assert.ok(errChunk, 'should yield an error chunk');
		assert.ok(errChunk.error && errChunk.error.includes('simulated mid-stream failure'));
	});

	test('stream completes when a tool throws (Strands contains the tool error)', async () => {
		const scope = new Scope('test-tool-err');
		const agent = new Agent(scope, 'terr', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			tools: (tool) => ({
				failingTool: tool({
					description: 'fails',
					parameters: z.object({}),
					needsApproval: false,
					handler: async () => {
						throw new Error('boom');
					},
				}),
			}),
		});
		// Strands catches a throwing tool handler and surfaces it as a tool result the model
		// handles, so the stream still runs the tool and completes rather than erroring out.
		const chunks = await drain(agent.streamSSE('run failingTool', { userId: 'test-user' }));
		assert.ok(
			chunks.some((c) => c.type === 'tool-call' && c.toolName === 'failingTool'),
			'should call the tool',
		);
		assert.ok(
			chunks.some((c) => c.type === 'done'),
			'stream should complete',
		);
	});

	test('yields an interrupt chunk on an approval-gated tool', async () => {
		const scope = new Scope('test-interrupt');
		const agent = new Agent(scope, 'itr', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			tools: (tool) => ({
				getWeather: tool({
					description: 'Get weather',
					parameters: z.object({ city: z.string() }),
					needsApproval: true,
					handler: async (input: any) => ({ temp: 22 }),
				}),
			}),
		});
		const chunks = await drain(agent.streamSSE('What is the weather in Paris?', { userId: 'test-user' }));
		const interrupt = chunks.find((c) => c.type === 'interrupt');
		assert.ok(interrupt, 'should yield an interrupt chunk');
		assert.ok(Array.isArray(interrupt.interrupts) && interrupt.interrupts.length > 0);
	});
});

// ── tool context ─────────────────────────────────────────────────────────────

describe('tool context', () => {
	test('context passed via stream reaches the tool handler', async () => {
		const scope = new Scope('test-ctx-flow');
		let seenContext: any;
		const agent = new Agent(scope, 'ctx', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			tools: (tool) => ({
				whoAmI: tool({
					description: 'reports the caller',
					parameters: z.object({}),
					needsApproval: false,
					handler: async ({ context }) => {
						seenContext = context;
						return { userId: context.userId };
					},
				}),
			}),
		});
		await drain(agent.streamSSE('use whoAmI', { userId: 'u-1', context: { userId: 'u-1' } }));
		assert.deepStrictEqual(seenContext, { userId: 'u-1' }, 'handler should receive the per-call context');
	});

	test('toolContextSchema validates context and throws on mismatch', async () => {
		const scope = new Scope('test-ctx-schema');
		const agent = new Agent(scope, 'ctxs', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			toolContextSchema: z.object({ userId: z.string() }),
			tools: (tool) => ({
				whoAmI: tool({
					description: 'reports the caller',
					parameters: z.object({}),
					needsApproval: false,
					handler: async ({ context }) => ({ userId: context.userId }),
				}),
			}),
		});
		// Missing required context — should throw from streamSSE()
		await assert.rejects(
			() => drain(agent.streamSSE('use whoAmI', { userId: 'u-1' } as any)),
			(err: any) => err.name === AgentErrors.InvalidModelConfig,
		);
	});

	test('toolContextSchema-typed context reaches the handler', async () => {
		const scope = new Scope('test-ctx-typed');
		let seenContext: any;
		const agent = new Agent(scope, 'ctxt', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			toolContextSchema: z.object({ userId: z.string() }),
			tools: (tool) => ({
				whoAmI: tool({
					description: 'reports the caller',
					parameters: z.object({}),
					needsApproval: false,
					handler: async ({ context }) => {
						seenContext = context;
						return { userId: context.userId };
					},
				}),
			}),
		});
		await drain(agent.streamSSE('use whoAmI', { userId: 'u-2', context: { userId: 'u-2' } }));
		assert.deepStrictEqual(seenContext, { userId: 'u-2' });
	});

	test('handler receives typed input from parameters', async () => {
		const scope = new Scope('test-ctx-input');
		let seenInput: any;
		const agent = new Agent(scope, 'ctxi', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			tools: (tool) => ({
				getWeather: tool({
					description: 'Get weather',
					parameters: z.object({ city: z.string() }),
					needsApproval: false,
					handler: async ({ input }) => {
						seenInput = input;
						return { ok: true };
					},
				}),
			}),
		});
		await drain(agent.streamSSE('what is the weather', { userId: 'u-3' }));
		assert.ok(seenInput && typeof seenInput.city === 'string', 'handler should receive validated input with city');
	});
});

import { FileBucket } from '@aws-blocks/bb-file-bucket';
import { FileBucketSnapshotStorage } from './file-bucket-snapshot-storage.js';

describe('FileBucketSnapshotStorage', () => {
	const scope = new Scope('test-snap');
	const bucket = new FileBucket(scope, 'sessions');
	const storage = new FileBucketSnapshotStorage(bucket);

	const location = { sessionId: 'sess-1', scope: 'agent' as const, scopeId: 'default' };
	const snapshot = {
		data: { messages: [{ role: 'user', content: [{ text: 'hello' }] }], state: {}, systemPrompt: 'test' },
		schemaVersion: '1.0',
		createdAt: new Date().toISOString(),
	};

	test('saveSnapshot with isLatest and loadSnapshot', async () => {
		await storage.saveSnapshot({ location, snapshotId: 'latest-1', isLatest: true, snapshot: snapshot as any });
		const loaded = await storage.loadSnapshot({ location });
		assert.deepStrictEqual(loaded, snapshot);
	});

	test('saveSnapshot immutable and loadSnapshot by id', async () => {
		await storage.saveSnapshot({ location, snapshotId: 'snap-abc', isLatest: false, snapshot: snapshot as any });
		const loaded = await storage.loadSnapshot({ location, snapshotId: 'snap-abc' });
		assert.deepStrictEqual(loaded, snapshot);
	});

	test('loadSnapshot returns null for missing snapshot', async () => {
		const loaded = await storage.loadSnapshot({ location: { ...location, sessionId: 'nonexistent' } });
		assert.strictEqual(loaded, null);
	});

	test('listSnapshotIds returns immutable snapshots only', async () => {
		const loc = { sessionId: 'sess-list', scope: 'agent' as const, scopeId: 'default' };
		await storage.saveSnapshot({ location: loc, snapshotId: 'id-1', isLatest: true, snapshot: snapshot as any });
		await storage.saveSnapshot({ location: loc, snapshotId: 'id-2', isLatest: false, snapshot: snapshot as any });
		await storage.saveSnapshot({ location: loc, snapshotId: 'id-3', isLatest: false, snapshot: snapshot as any });
		const ids = await storage.listSnapshotIds({ location: loc });
		assert.ok(!ids.includes('id-1'), 'should not include latest-only snapshot');
		assert.ok(ids.includes('id-2'));
		assert.ok(ids.includes('id-3'));
	});

	test('listSnapshotIds respects limit', async () => {
		const loc = { sessionId: 'sess-list', scope: 'agent' as const, scopeId: 'default' };
		const ids = await storage.listSnapshotIds({ location: loc, limit: 1 });
		assert.strictEqual(ids.length, 1);
	});

	test('deleteSession removes all data', async () => {
		const loc = { sessionId: 'sess-del', scope: 'agent' as const, scopeId: 'default' };
		await storage.saveSnapshot({ location: loc, snapshotId: 'x', isLatest: true, snapshot: snapshot as any });
		await storage.saveManifest({
			location: loc,
			manifest: { schemaVersion: '1.0', updatedAt: new Date().toISOString() },
		});
		await storage.deleteSession({ sessionId: 'sess-del' });
		const loaded = await storage.loadSnapshot({ location: loc });
		assert.strictEqual(loaded, null);
	});

	test('saveManifest and loadManifest', async () => {
		const loc = { sessionId: 'sess-man', scope: 'agent' as const, scopeId: 'default' };
		const manifest = { schemaVersion: '1.0', updatedAt: '2026-01-01T00:00:00Z' };
		await storage.saveManifest({ location: loc, manifest });
		const loaded = await storage.loadManifest({ location: loc });
		assert.deepStrictEqual(loaded, manifest);
	});

	test('loadManifest returns default for missing manifest', async () => {
		const loc = { sessionId: 'sess-no-man', scope: 'agent' as const, scopeId: 'default' };
		const loaded = await storage.loadManifest({ location: loc });
		assert.strictEqual(loaded.schemaVersion, '1.0');
		assert.ok(loaded.updatedAt);
	});
});

// ── model-factory ───────────────────────────────────────────────────────────

describe('model-factory', () => {
	test('creates CannedProvider for canned config', async () => {
		const model = await createStrandsModel({ provider: 'canned' });
		assert.ok(model);
	});

	test('throws on bedrock without modelId', async () => {
		await assert.rejects(
			() => createStrandsModel({ provider: 'bedrock' } as any),
			(err: any) => err.name === AgentErrors.InvalidModelConfig,
		);
	});

	test('throws on openai-api without modelId', async () => {
		await assert.rejects(
			() => createStrandsModel({ provider: 'openai-api' } as any),
			(err: any) => err.name === AgentErrors.InvalidModelConfig,
		);
	});

	test('throws on unknown provider', async () => {
		await assert.rejects(
			() => createStrandsModel({ provider: 'unknown' } as any),
			(err: any) => err.name === AgentErrors.InvalidModelConfig,
		);
	});

	test('resolves async apiKey function for openai-api', async () => {
		const resolver = async () => 'sk-test-key';
		// This will create an OpenAIModel — we just verify it doesn't throw
		const model = await createStrandsModel({ provider: 'openai-api', modelId: 'gpt-4', apiKey: resolver });
		assert.ok(model);
	});

	test('throws on openai-api without apiKey or env var', async () => {
		const original = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		try {
			await assert.rejects(
				() => createStrandsModel({ provider: 'openai-api', modelId: 'gpt-4' }),
				(err: any) => err.name === AgentErrors.InvalidModelConfig,
			);
		} finally {
			if (original) process.env.OPENAI_API_KEY = original;
		}
	});
});

// ── useChat ──────────────────────────────────────────────────────────────────

import { useChat } from './index.hooks.js';

describe('useChat', () => {
	/** Build a `streamChunks` transport that yields a fixed list of chunks for each turn. */
	function fixedStream(chunks: AgentStreamChunk[]) {
		return async function* () {
			for (const c of chunks) yield c;
		};
	}

	test('onError is called when error chunk arrives', async () => {
		let errorReceived: string | undefined;
		const loadingStates: boolean[] = [];

		const chat = useChat({
			api: {
				createConversation: async () => ({ conversationId: 'conv-1' }),
				getConversation: async () => ({ messages: [] }),
			},
			streamChunks: fixedStream([{ type: 'error', error: 'model throttled' }]),
			onLoadingChange: (l) => {
				loadingStates.push(l);
			},
			onError: (err) => {
				errorReceived = err;
			},
		});

		await chat.sendMessage('hello');

		assert.strictEqual(errorReceived, 'model throttled');
		assert.strictEqual(loadingStates.at(-1), false, 'loading should be false after error');
	});

	test('onInterrupt is called when interrupt chunk arrives', async () => {
		let interruptsReceived: any[] | undefined;
		const loadingStates: boolean[] = [];

		const chat = useChat({
			api: {
				createConversation: async () => ({ conversationId: 'conv-1' }),
				getConversation: async () => ({ messages: [] }),
			},
			streamChunks: fixedStream([
				{
					type: 'interrupt',
					interrupts: [{ id: 'int-1', name: 'approve:deleteRecords', reason: { tool: 'deleteRecords' } }],
				},
			]),
			onLoadingChange: (l) => {
				loadingStates.push(l);
			},
			onInterrupt: (interrupts) => {
				interruptsReceived = interrupts;
			},
		});

		await chat.sendMessage('hello');

		assert.ok(interruptsReceived, 'onInterrupt should be called');
		assert.strictEqual(interruptsReceived!.length, 1);
		assert.strictEqual(interruptsReceived![0].name, 'approve:deleteRecords');
		assert.strictEqual(loadingStates.at(-1), false, 'loading should be false after interrupt');
	});

	test('respondToInterrupt streams the resume turn and adds an approval message', async () => {
		const calls: Array<{ message?: string; interruptResponses?: any }> = [];
		const chat = useChat({
			api: {
				createConversation: async () => ({ conversationId: 'conv-1' }),
				getConversation: async () => ({ messages: [] }),
			},
			streamChunks: (args) => {
				calls.push({ message: args.message, interruptResponses: args.interruptResponses });
				// First turn interrupts; resume turn completes.
				const chunks: AgentStreamChunk[] = args.interruptResponses
					? [{ type: 'done', text: 'resumed' }]
					: [{ type: 'interrupt', interrupts: [{ id: 'int-1', name: 'approve:delete' }] }];
				return (async function* () {
					for (const c of chunks) yield c;
				})();
			},
		});

		await chat.sendMessage('hello');
		await chat.respondToInterrupt([{ interruptId: 'int-1', approved: true }]);

		// The resume turn passed interruptResponses through the transport.
		const resumeCall = calls.find((c) => c.interruptResponses);
		assert.ok(resumeCall, 'resume turn should stream with interruptResponses');
		assert.strictEqual(resumeCall!.interruptResponses[0].response, 'yes');
		// Approval message should be in messages
		const messages = chat.getMessages();
		assert.ok(
			messages.some((m) => m.role === 'approval' && m.content === 'Approved'),
			'should have approval message',
		);
	});

	test('interrupt removes empty assistant placeholder', async () => {
		let lastMessages: any[] = [];

		const chat = useChat({
			api: {
				createConversation: async () => ({ conversationId: 'conv-1' }),
				getConversation: async () => ({ messages: [] }),
			},
			streamChunks: fixedStream([{ type: 'interrupt', interrupts: [{ id: 'int-1', name: 'approve:delete' }] }]),
			onMessagesChange: (msgs) => {
				lastMessages = msgs;
			},
		});

		await chat.sendMessage('hello');
		// After the interrupt, the empty assistant placeholder should be removed.
		assert.ok(
			!lastMessages.some((m) => m.role === 'assistant' && m.content === ''),
			'empty placeholder should be removed',
		);
	});
});

describe('checkModelHealth', () => {
	const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => log } as any;

	test('canned provider is always healthy', async () => {
		assert.strictEqual(await checkModelHealth({ provider: 'canned' }, log), true);
	});

	test('bedrock foundation model found returns true', async () => {
		let callCount = 0;
		const mockClient = {
			send: async () => {
				callCount++;
				if (callCount === 1) throw new Error('not an inference profile');
				return { modelDetails: { modelId: 'anthropic.claude-3-haiku' } };
			},
		};
		assert.strictEqual(
			await checkModelHealth({ provider: 'bedrock', modelId: 'anthropic.claude-3-haiku' }, log, mockClient),
			true,
		);
	});

	test('bedrock model not found returns false', async () => {
		const mockClient = {
			send: async () => {
				throw new Error('not found');
			},
		};
		assert.strictEqual(
			await checkModelHealth({ provider: 'bedrock', modelId: 'bad.model' }, log, mockClient),
			false,
		);
	});

	test('bedrock credential error returns false', async () => {
		const err = new Error('no creds');
		err.name = 'CredentialsProviderError';
		const mockClient = {
			send: async () => {
				throw err;
			},
		};
		assert.strictEqual(
			await checkModelHealth({ provider: 'bedrock', modelId: 'anthropic.claude-3-haiku' }, log, mockClient),
			false,
		);
	});

	test('bedrock inference profile found returns true', async () => {
		const mockClient = { send: async () => ({ inferenceProfileName: 'US Claude Sonnet' }) };
		assert.strictEqual(
			await checkModelHealth({ provider: 'bedrock', modelId: 'us.anthropic.claude-sonnet-4' }, log, mockClient),
			true,
		);
	});

	test('bedrock global inference profile found returns true', async () => {
		const mockClient = { send: async () => ({ inferenceProfileName: 'Global Claude Opus' }) };
		assert.strictEqual(
			await checkModelHealth(
				{ provider: 'bedrock', modelId: 'global.anthropic.claude-opus-4-8-v1' },
				log,
				mockClient,
			),
			true,
		);
	});

	test('openai-api with unreachable endpoint returns false', async () => {
		assert.strictEqual(
			await checkModelHealth(
				{ provider: 'openai-api', modelId: 'gpt-4', endpoint: 'http://localhost:19999/v1' },
				log,
			),
			false,
		);
	});

	// Regression: an endpoint that responds HTTP 200 with a NON-JSON body (an HTML
	// error page, a captive portal, a misconfigured proxy, or a non-OpenAI server
	// sharing the URL) must be treated as unhealthy — NOT throw. Previously the
	// unguarded `await res.json()` threw a SyntaxError that escaped checkModelHealth
	// and aborted the model fallback loop in createStrandsAgent(), so the implicit
	// canned fallback never ran and the agent failed outright. checkModelHealth must
	// return false here so the next candidate (e.g. canned) is tried.
	test('openai-api with 200 non-JSON body returns false (does not throw)', async () => {
		const http = await import('node:http');
		const server = http.createServer((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end('<html>Service OK</html>');
		});
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as import('node:net').AddressInfo).port;
		// Capture warnings so we can assert the diagnostic includes a snippet of the
		// offending body — that snippet is what makes a misconfigured proxy / captive
		// portal obvious to a developer reading the logs.
		const warnings: Array<{ msg: string; meta?: any }> = [];
		const capturingLog = { ...log, warn: (msg: string, meta?: any) => warnings.push({ msg, meta }) } as any;
		try {
			const healthy = await checkModelHealth(
				{ provider: 'openai-api', modelId: 'llama3', endpoint: `http://localhost:${port}/v1` },
				capturingLog,
			);
			assert.strictEqual(healthy, false, 'non-JSON 200 response should be treated as unhealthy, not throw');
			const warned = warnings.find((w) => w.meta && 'bodySnippet' in w.meta);
			assert.ok(warned, 'should warn about the non-JSON body');
			assert.match(warned!.meta.bodySnippet, /<html>/, 'warning should include a snippet of the offending body');
		} finally {
			server.close();
		}
	});
	test('openai-api health check uses explicit apiKey string from config', async () => {
		const http = await import('node:http');
		let receivedAuth = '';
		const server = http.createServer((req, res) => {
			receivedAuth = req.headers.authorization ?? '';
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
		});
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as import('node:net').AddressInfo).port;
		try {
			const healthy = await checkModelHealth(
				{
					provider: 'openai-api',
					modelId: 'test-model',
					endpoint: `http://localhost:${port}/v1`,
					apiKey: 'sk-explicit',
				},
				log,
			);
			assert.strictEqual(healthy, true);
			assert.strictEqual(receivedAuth, 'Bearer sk-explicit');
		} finally {
			server.close();
		}
	});

	test('openai-api health check resolves async apiKey function', async () => {
		const http = await import('node:http');
		let receivedAuth = '';
		const server = http.createServer((req, res) => {
			receivedAuth = req.headers.authorization ?? '';
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
		});
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as import('node:net').AddressInfo).port;
		try {
			const healthy = await checkModelHealth(
				{
					provider: 'openai-api',
					modelId: 'test-model',
					endpoint: `http://localhost:${port}/v1`,
					apiKey: () => Promise.resolve('sk-from-resolver'),
				},
				log,
			);
			assert.strictEqual(healthy, true);
			assert.strictEqual(receivedAuth, 'Bearer sk-from-resolver');
		} finally {
			server.close();
		}
	});

	test('openai-api health check uses OPENAI_API_KEY env var when no apiKey in config', async () => {
		const http = await import('node:http');
		let receivedAuth = '';
		const server = http.createServer((req, res) => {
			receivedAuth = req.headers.authorization ?? '';
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
		});
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as import('node:net').AddressInfo).port;
		const original = process.env.OPENAI_API_KEY;
		try {
			process.env.OPENAI_API_KEY = 'sk-test-from-env';
			const healthy = await checkModelHealth(
				{ provider: 'openai-api', modelId: 'test-model', endpoint: `http://localhost:${port}/v1` },
				log,
			);
			assert.strictEqual(healthy, true);
			assert.strictEqual(receivedAuth, 'Bearer sk-test-from-env');
		} finally {
			process.env.OPENAI_API_KEY = original;
			server.close();
		}
	});
});

// ── Model Presets ─────────────────────────────────────────────────────────────

describe('default model', () => {
	test('agent can be created without model config', () => {
		const s = new Scope('test-default-model');
		const agent = new Agent(s, 'no-model', { systemPrompt: 'test' });
		assert.ok(agent);
	});
});

describe('BedrockModels presets', () => {
	test('BALANCED resolves to a bedrock provider', async () => {
		assert.strictEqual(BedrockModels.BALANCED.provider, 'bedrock');
		assert.ok(BedrockModels.BALANCED.modelId);
	});

	test('all presets have provider bedrock and a modelId', () => {
		for (const [name, config] of Object.entries(BedrockModels)) {
			assert.strictEqual(config.provider, 'bedrock', `${name} should have provider bedrock`);
			assert.ok(config.modelId, `${name} should have a modelId`);
		}
	});

	test('BALANCED flows through createStrandsModel to BedrockModel', async () => {
		const model = await createStrandsModel(BedrockModels.BALANCED);
		assert.ok(model, 'should create a model instance');
	});
});

describe('OllamaModels presets', () => {
	test('all presets have provider openai-api and localhost endpoint', () => {
		for (const [name, config] of Object.entries(OllamaModels)) {
			assert.strictEqual(config.provider, 'openai-api', `${name} should have provider openai-api`);
			assert.ok(config.modelId, `${name} should have a modelId`);
			assert.strictEqual(
				config.endpoint,
				'http://localhost:11434/v1',
				`${name} should use default Ollama endpoint`,
			);
		}
	});
});

// ── deployed Agent S3Storage region (multi-region) ──────────────────────────
// Regression for #120: the deployed (aws-runtime) Agent must build Strands' S3Storage
// with the Lambda execution region (AWS_REGION). Omitting `region` defaults S3Storage to
// us-east-1 and breaks deploys elsewhere — the session bucket lives in the deploy region,
// so snapshots hit a cross-region 301 PermanentRedirect. index.test.ts otherwise only
// drives the mock/local path, so this covers agent.aws.ts by spying the S3Storage ctor.

import type { SnapshotManifest, SnapshotStorage } from '@strands-agents/sdk';
import type { S3StorageConfig } from '@strands-agents/sdk/session/s3-storage';
import { createDeployedSnapshotStorage } from './agent.aws.js';
import { Agent as DeployedAgent } from './index.aws.js';

describe('deployed Agent S3Storage region (multi-region)', () => {
	// Type-safe stand-in for S3Storage that records every config it's constructed with,
	// so we assert exactly what agent.aws.ts passes in — no S3Storage/AWS SDK internals.
	function s3StorageSpy() {
		const configs: S3StorageConfig[] = [];
		class Spy implements SnapshotStorage {
			constructor(config: S3StorageConfig) {
				configs.push(config);
			}
			async saveSnapshot(): Promise<void> {}
			async loadSnapshot(): Promise<null> {
				return null;
			}
			async listSnapshotIds(): Promise<string[]> {
				return [];
			}
			async deleteSession(): Promise<void> {}
			async loadManifest(): Promise<SnapshotManifest> {
				return { schemaVersion: '1.0', updatedAt: new Date().toISOString() };
			}
			async saveManifest(): Promise<void> {}
		}
		return { configs, Spy };
	}

	// Capture the S3StorageConfig the deployed factory builds for a given AWS_REGION.
	function configForRegion(region: string, scopeId: string): S3StorageConfig {
		const prev = process.env.AWS_REGION;
		process.env.AWS_REGION = region;
		try {
			const { configs, Spy } = s3StorageSpy();
			const bucket = new FileBucket(new Scope(scopeId), 'sn');
			createDeployedSnapshotStorage(bucket, Spy);
			assert.strictEqual(configs.length, 1, 'S3Storage should be constructed exactly once');
			assert.strictEqual(configs[0].bucket, bucket.fullId, 'session bucket id should be passed through');
			return configs[0];
		} finally {
			if (prev === undefined) delete process.env.AWS_REGION;
			else process.env.AWS_REGION = prev;
		}
	}

	test('constructs S3Storage with the Lambda execution region (eu-west-1)', () => {
		const config = configForRegion('eu-west-1', 'test-s3-region-euw1');
		assert.strictEqual(config.region, 'eu-west-1');
		assert.notStrictEqual(config.region, 'us-east-1');
	});

	test('does not hard-pin us-east-1 when deployed to another region (ap-southeast-2)', () => {
		const config = configForRegion('ap-southeast-2', 'test-s3-region-apse2');
		assert.strictEqual(config.region, 'ap-southeast-2');
		assert.notStrictEqual(config.region, 'us-east-1');
	});

	test('deployed Agent constructs on the aws-runtime path', () => {
		const agent = new DeployedAgent(new Scope('test-s3-agent'), 'r', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' } },
		});
		assert.ok(agent);
	});
});

// ── AgentCore WebSocket URL builder ─────────────────────────────────────────

import { buildAgentCoreWsUrl } from './agent.aws.js';

describe('buildAgentCoreWsUrl', () => {
	const arn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my-runtime-abc123';

	test('builds a wss URL against the regional data-plane host with the ARN encoded', () => {
		const url = new URL(buildAgentCoreWsUrl(arn, 'sess-1'));
		assert.strictEqual(url.protocol, 'wss:');
		assert.strictEqual(url.hostname, 'bedrock-agentcore.us-east-1.amazonaws.com');
		// The ARN is percent-encoded into the path segment.
		assert.ok(url.pathname.startsWith(`/runtimes/${encodeURIComponent(arn)}/ws`));
	});

	test('embeds the session id as the runtime-session-id query param', () => {
		const url = new URL(buildAgentCoreWsUrl(arn, 'conv-42'));
		assert.strictEqual(url.searchParams.get('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'), 'conv-42');
	});

	test('derives region from the ARN (not hard-pinned)', () => {
		const apse2 = 'arn:aws:bedrock-agentcore:ap-southeast-2:123456789012:runtime/r-xyz';
		assert.strictEqual(new URL(buildAgentCoreWsUrl(apse2, 's')).hostname, 'bedrock-agentcore.ap-southeast-2.amazonaws.com');
	});

	test('throws on an ARN without a region', () => {
		assert.throws(() => buildAgentCoreWsUrl('not-an-arn', 's'), /region/);
	});
});

// ── Browser WebSocket transport ─────────────────────────────────────────────

import { createAgentCoreWsTransport, buildBearerSubprotocols } from './ws-transport.js';

/**
 * Minimal fake of the browser WebSocket for driving the transport. Records the URL +
 * subprotocols + sent frames, and lets the test push server frames / lifecycle events.
 */
class FakeWebSocket {
	static CONNECTING = 0 as const;
	static OPEN = 1 as const;
	static CLOSING = 2 as const;
	static CLOSED = 3 as const;
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSING = 2;
	readonly CLOSED = 3;
	readyState = 0;
	sent: string[] = [];
	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	constructor(
		public url: string,
		public protocols: string[],
	) {}
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.closed = true;
		this.readyState = this.CLOSED;
	}
	// Test drivers.
	open() {
		this.readyState = this.OPEN;
		this.onopen?.();
	}
	emit(event: string, data?: Record<string, unknown>) {
		this.onmessage?.({ data: JSON.stringify({ event, data }) });
	}
	fail() {
		this.onerror?.();
	}
}

describe('buildBearerSubprotocols', () => {
	test('encodes the token base64url and pairs it with the scheme marker', () => {
		const [encoded, marker] = buildBearerSubprotocols('a.b.c');
		assert.strictEqual(marker, 'base64UrlBearerAuthorization');
		assert.ok(encoded.startsWith('base64UrlBearerAuthorization.'));
		// base64url alphabet only — no +, /, or = padding.
		const payload = encoded.slice('base64UrlBearerAuthorization.'.length);
		assert.doesNotMatch(payload, /[+/=]/);
	});
});

describe('createAgentCoreWsTransport', () => {
	function harness(endpoint = { wsUrl: 'wss://host/runtimes/arn/ws?X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=c1', token: 'tok.tok.tok' }) {
		let socket: FakeWebSocket | undefined;
		const WebSocketImpl = function (url: string, protocols: string[]) {
			socket = new FakeWebSocket(url, protocols);
			return socket;
		} as unknown as typeof WebSocket;
		(WebSocketImpl as unknown as { CONNECTING: number }).CONNECTING = 0;
		const streamChunks = createAgentCoreWsTransport(async () => endpoint, { WebSocketImpl });
		return { streamChunks, getSocket: () => socket as FakeWebSocket };
	}

	test('opens the socket with the endpoint URL + bearer subprotocols and sends the prompt', async () => {
		const { streamChunks, getSocket } = harness();
		const gen = streamChunks({ conversationId: 'c1', message: 'hello' })[Symbol.asyncIterator]();
		// Kick off iteration so the endpoint resolves + socket opens.
		const first = gen.next();
		await new Promise((r) => setTimeout(r, 0));
		const socket = getSocket();
		assert.strictEqual(socket.url, 'wss://host/runtimes/arn/ws?X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=c1');
		assert.deepStrictEqual(socket.protocols, buildBearerSubprotocols('tok.tok.tok'));
		socket.open();
		assert.deepStrictEqual(JSON.parse(socket.sent[0]), { prompt: 'hello' });
		// Feed one chunk then complete so the pending next() resolves.
		socket.emit('text-delta', { delta: 'hi' });
		const { value } = await first;
		assert.deepStrictEqual(value, { type: 'text-delta', delta: 'hi' });
		socket.emit('turn-complete');
	});

	test('reconstructs chunks and ends on turn-complete', async () => {
		const { streamChunks, getSocket } = harness();
		const chunks: AgentStreamChunk[] = [];
		const p = (async () => {
			for await (const c of streamChunks({ conversationId: 'c1', message: 'go' })) chunks.push(c);
		})();
		await new Promise((r) => setTimeout(r, 0));
		const socket = getSocket();
		socket.open();
		socket.emit('text-delta', { delta: 'a' });
		socket.emit('done', { usage: { tokens: 1 } });
		socket.emit('turn-complete');
		await p;
		assert.deepStrictEqual(chunks, [
			{ type: 'text-delta', delta: 'a' },
			{ type: 'done', usage: { tokens: 1 } },
		]);
		assert.ok(socket.closed, 'socket closes when the turn ends');
	});

	test('sends interruptResponses on resume', async () => {
		const { streamChunks, getSocket } = harness();
		const gen = streamChunks({ conversationId: 'c1', interruptResponses: [{ interruptId: 'i1', response: 'yes' }] })[Symbol.asyncIterator]();
		const first = gen.next();
		await new Promise((r) => setTimeout(r, 0));
		const socket = getSocket();
		socket.open();
		assert.deepStrictEqual(JSON.parse(socket.sent[0]), {
			prompt: '',
			interruptResponses: [{ interruptId: 'i1', response: 'yes' }],
		});
		socket.emit('turn-complete');
		await first;
	});

	test('emits a terminal error chunk when the socket errors', async () => {
		const { streamChunks, getSocket } = harness();
		const chunks: AgentStreamChunk[] = [];
		const p = (async () => {
			for await (const c of streamChunks({ conversationId: 'c1', message: 'go' })) chunks.push(c);
		})();
		await new Promise((r) => setTimeout(r, 0));
		const socket = getSocket();
		socket.open();
		socket.fail();
		await p;
		assert.strictEqual(chunks.length, 1);
		assert.strictEqual(chunks[0].type, 'error');
		assert.match((chunks[0] as { error: string }).error, /failed/);
	});
});
