// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Scope } from '@aws-blocks/core';
import { Agent, AgentErrors, InterruptError, BedrockModels, OllamaModels } from './index.mock.js';
import { CannedProvider } from './providers/canned.js';
import { checkModelHealth } from './model-factory.js';
import { z } from 'zod';
import { createStrandsModel } from './model-factory.js';

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
		const agent = new Agent(scope, 'a', { systemPrompt: 'test', model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } } });
		const id = await agent.createConversationId("test-user");
		assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	test('returns unique IDs', async () => {
		const scope = new Scope('test-uuid2');
		const agent = new Agent(scope, 'b', { systemPrompt: 'test', model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } } });
		const id1 = await agent.createConversationId("test-user");
		const id2 = await agent.createConversationId("test-user");
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
			tools: (tool) => ({ badTool: tool({ description: 'has both',
				parameters: z.object({}),
				needsApproval: true,
				interrupt: () => {},
				handler: async () => ({}), }) }),
		});
		const result = await agent.stream('hello', { userId: 'test-user' });
		await assert.rejects(
			() => result.complete(),
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
			tools: (tool) => ({ badTool2: tool({ description: 'has trustable + interrupt',
				parameters: z.object({}),
				trustable: true,
				interrupt: () => {},
				handler: async () => ({}), }) }),
		});
		const result = await agent.stream('hello', { userId: 'test-user' });
		await assert.rejects(
			() => result.complete(),
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
			tools: (tool) => ({ approvalTool: tool({ description: 'approval only',
				parameters: z.object({}),
				needsApproval: false,
				handler: async () => ({ ok: true }), }) }),
		});
		const result = await agent.stream('hello', { userId: 'test-user' });
		assert.ok(result.channelId);
	});

	test('interrupt alone works', async () => {
		const scope = new Scope('test-intr');
		const agent = new Agent(scope, 'it', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			tools: (tool) => ({ interruptTool: tool({ description: 'interrupt only',
				parameters: z.object({}),
				interrupt: () => {},
				handler: async () => ({ ok: true }), }) }),
		});
		const result = await agent.stream('hello', { userId: 'test-user' });
		assert.ok(result.channelId);
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
	const agent = new Agent(scope, 'io', { inferenceOnly: true, systemPrompt: 'test', model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } } });

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
		const result = await agent.stream('hello', { userId: 'test-user' });
		assert.ok(result.channelId);
	});

	// Regression: resuming an interrupted agent needs a conversationId to restore
	// the paused session (the SessionManager is keyed by conversationId). Without
	// one — as is always the case for inferenceOnly agents — resume() previously
	// submitted a job that ran a fresh agent with nothing to apply the responses to.
	// It must now fail fast with a clear error instead of silently doing nothing.
	test('resume without a conversationId throws InterruptRequired', async () => {
		await assert.rejects(
			() => agent.resume('chan-1', [{ interruptId: 'i-1', approved: true }]),
			(err: any) => {
				assert.strictEqual(err.name, AgentErrors.InterruptRequired);
				assert.match(err.message, /conversationId/);
				// For an inferenceOnly agent the message must explain it's a
				// fundamental limitation (no persistent session), not a missing param.
				assert.match(err.message, /inferenceOnly/);
				return true;
			},
		);
	});
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
		const agent = new Agent(scope, 'do', { systemPrompt: 'test', model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } } });

		const ownerId = 'owner-1';
		const convId = await agent.createConversationId(ownerId);
		const r = await agent.stream('hello', { conversationId: convId, userId: ownerId });
		await r.complete();

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
		const agent = new Agent(scope, 'do2', { systemPrompt: 'test', model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } } });

		const ownerId = 'owner-1';
		const convId = await agent.createConversationId(ownerId);
		const r = await agent.stream('hello', { conversationId: convId, userId: ownerId });
		await r.complete();
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
		for await (const event of provider.stream([{ role: 'user', content: [{ text: 'tell me about the weather' }] }] as any)) {
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
			for await (const event of provider.stream([{ role: 'user', content: [{ text: prompt }] }] as any, { toolSpecs } as any)) {
				if (event.type === 'modelContentBlockStartEvent' && event.start?.type === 'toolUseStart') started.push(event.start.name);
			}
			assert.deepStrictEqual(started, [], `prompt "${prompt}" must not trigger ${tool}`);
		}
	});

	// Genuine whole-word mentions must still trigger (documented mock behavior).
	test('still triggers a tool when a camelCase word appears as a whole word', async () => {
		const provider = new CannedProvider();
		const toolSpecs = [{ name: 'getOrder', description: '', inputSchema: {} }];
		const started: string[] = [];
		for await (const event of provider.stream([{ role: 'user', content: [{ text: 'what is the status of my order' }] }] as any, { toolSpecs } as any)) {
			if (event.type === 'modelContentBlockStartEvent' && event.start?.type === 'toolUseStart') started.push(event.start.name);
		}
		assert.deepStrictEqual(started, ['getOrder']);
	});

	test('responds to tool result with acknowledgment', async () => {
		const provider = new CannedProvider();
		const chunks: string[] = [];
		for await (const event of provider.stream(
			[{ role: 'user', content: [{ toolResult: { toolUseId: 'test', content: [{ text: 'result' }] } }] }] as any,
		)) {
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

	test("test canned provider", async () => {
		const scope = new Scope('test-canned');
		const agent = new Agent(scope, 'canned', { inferenceOnly: false, systemPrompt: 'test', model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } } });
		const result = await agent.stream('hello', { userId: 'test-user' });
		assert.ok(result.channelId);
		const done = await result.complete();
		assert.strictEqual(done.type, 'done');
		assert.ok(done.text && done.text.length > 0, 'should have response text');
	});

	test("getConversation with limit returns most recent messages", async () => {
		const scope = new Scope('test-limit');
		const agent = new Agent(scope, 'lim', { systemPrompt: 'test', model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } } });
		const convId = await agent.createConversationId('test-user');
		// Send 3 messages to create at least 6 entries (user + assistant each)
		for (const msg of ['first', 'second', 'third']) {
			const r = await agent.stream(msg, { conversationId: convId, userId: 'test-user' });
			await r.complete();
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
	test("getConversation with limit 0 or negative returns no messages", async () => {
		const scope = new Scope('test-limit-zero');
		const agent = new Agent(scope, 'lim0', { systemPrompt: 'test', model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } } });
		const convId = await agent.createConversationId('test-user');
		for (const msg of ['first', 'second']) {
			const r = await agent.stream(msg, { conversationId: convId, userId: 'test-user' });
			await r.complete();
		}
		assert.ok((await agent.getConversation(convId)).length > 0, 'sanity: conversation has messages');
		assert.strictEqual((await agent.getConversation(convId, { limit: 0 })).length, 0, 'limit 0 should return an empty array, not all messages');
		assert.strictEqual((await agent.getConversation(convId, { limit: -1 })).length, 0, 'negative limit should return an empty array, not all messages');
	});

	test("token mode publishes multiple chunks", async () => {
		const scope = new Scope('test-token');
		const agent = new Agent(scope, 'tok', { systemPrompt: 'test', model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } }, streamingMode: 'token' });
		const chunks: any[] = [];
		const result = await agent.stream('hello', { userId: 'test-user' });
		const ch = await result.channel;
		const sub = ch.subscribe((chunk: any) => { chunks.push(chunk); });
		await result.complete();
		sub.unsubscribe();
		const textChunks = chunks.filter(c => c.type === 'text-delta');
		assert.ok(textChunks.length > 1, 'token mode should produce multiple text-delta chunks');
	});

	test("block mode publishes fewer chunks than token mode", async () => {
		const scope = new Scope('test-block');
		const agent = new Agent(scope, 'blk', { systemPrompt: 'test', model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } }, streamingMode: 'block' });
		const chunks: any[] = [];
		const result = await agent.stream('hello', { userId: 'test-user' });
		const ch = await result.channel;
		const sub = ch.subscribe((chunk: any) => { chunks.push(chunk); });
		await result.complete();
		sub.unsubscribe();
		const textChunks = chunks.filter(c => c.type === 'text-delta');
		assert.ok(textChunks.length === 1, 'block mode should produce a single text-delta chunk with full content');
		assert.ok(textChunks[0].text.length > 0, 'block chunk should have content');
	});

	test("block mode flushes partial buffer on stream error", async () => {
		const scope = new Scope('test-block-err');
		const agent = new Agent(scope, 'blkerr', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'throwing' as any }, local: { provider: 'throwing' as any } },
			streamingMode: 'block',
		});
		const chunks: any[] = [];
		const result = await agent.stream('hello', { userId: 'test-user' });
		const ch = await result.channel;
		ch.subscribe((chunk: any) => { chunks.push(chunk); });
		// Wait for error to propagate through AsyncJob
		await new Promise(resolve => setTimeout(resolve, 2000));
		const textChunks = chunks.filter((c: any) => c.type === 'text-delta');
		const errorChunk = chunks.find((c: any) => c.type === 'error');
		assert.ok(textChunks.length > 0, 'should flush partial block buffer before error');
		assert.strictEqual(textChunks[0].text, 'partial text', 'flushed text should contain buffered content');
		assert.ok(errorChunk, 'should receive an error chunk after buffer flush');
	});

	test("complete() rejects on error chunk", async () => {
		const scope = new Scope('test-complete-err');
		const agent = new Agent(scope, 'cerr', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'throwing' as any }, local: { provider: 'throwing' as any } },
		});
		const result = await agent.stream('hello', { userId: 'test-user' });
		await assert.rejects(() => result.complete(), (err: any) => {
			assert.strictEqual(err.name, 'StreamFailedException');
			assert.ok(err.message.includes('simulated mid-stream failure'));
			return true;
		});
	});

	test("complete() resolves when a tool throws", async () => {
		const scope = new Scope('test-tool-err');
		const agent = new Agent(scope, 'terr', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			tools: (tool) => ({ failingTool: tool({ description: 'fails', parameters: z.object({}), needsApproval: false, handler: async () => { throw new Error('boom'); } }) }),
		});
		const result = await agent.stream('run failingTool', { userId: 'test-user' });
		const chunk = await result.complete();
		assert.strictEqual(chunk.type, 'done', 'Strands catches tool errors — stream completes normally');
		assert.ok(chunk.text && chunk.text.length > 0, 'should have response text');
	});

	test("complete() rejects with InterruptError on interrupt chunk", async () => {
		const scope = new Scope('test-interrupt');
		const agent = new Agent(scope, 'itr', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			tools: (tool) => ({ getWeather: tool({ description: 'Get weather', parameters: z.object({ city: z.string() }), needsApproval: true, handler: async (input: any) => ({ temp: 22 }) }) }),
		});
		const result = await agent.stream('What is the weather in Paris?', { userId: 'test-user' });
		await assert.rejects(() => result.complete(), (err: any) => {
			assert.strictEqual(err.name, 'InterruptRequiredException');
			assert.ok(err instanceof InterruptError, 'should be an InterruptError instance');
			assert.ok(err.interrupts.length > 0, 'should have interrupts attached');
			return true;
		});
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
			tools: (tool) => ({ whoAmI: tool({ description: 'reports the caller',
				parameters: z.object({}),
				needsApproval: false,
				handler: async ({ context }) => { seenContext = context; return { userId: context.userId }; }, }) }),
		});
		const result = await agent.stream('use whoAmI', { userId: 'u-1', context: { userId: 'u-1' } });
		await result.complete();
		assert.deepStrictEqual(seenContext, { userId: 'u-1' }, 'handler should receive the per-call context');
	});

	test('toolContextSchema validates context and throws on mismatch', async () => {
		const scope = new Scope('test-ctx-schema');
		const agent = new Agent(scope, 'ctxs', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			toolContextSchema: z.object({ userId: z.string() }),
			tools: (tool) => ({ whoAmI: tool({ description: 'reports the caller',
				parameters: z.object({}),
				needsApproval: false,
				handler: async ({ context }) => ({ userId: context.userId }), }) }),
		});
		// Missing required context — should throw synchronously from stream()
		await assert.rejects(
			() => agent.stream('use whoAmI', { userId: 'u-1' } as any),
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
			tools: (tool) => ({ whoAmI: tool({ description: 'reports the caller',
				parameters: z.object({}),
				needsApproval: false,
				handler: async ({ context }) => { seenContext = context; return { userId: context.userId }; }, }) }),
		});
		const result = await agent.stream('use whoAmI', { userId: 'u-2', context: { userId: 'u-2' } });
		await result.complete();
		assert.deepStrictEqual(seenContext, { userId: 'u-2' });
	});

	test('handler receives typed input from parameters', async () => {
		const scope = new Scope('test-ctx-input');
		let seenInput: any;
		const agent = new Agent(scope, 'ctxi', {
			systemPrompt: 'test',
			model: { deployed: { provider: 'canned' }, local: { provider: 'canned' } },
			tools: (tool) => ({ getWeather: tool({ description: 'Get weather',
				parameters: z.object({ city: z.string() }),
				needsApproval: false,
				handler: async ({ input }) => { seenInput = input; return { ok: true }; }, }) }),
		});
		const result = await agent.stream('what is the weather', { userId: 'u-3' });
		await result.complete();
		assert.ok(seenInput && typeof seenInput.city === 'string', 'handler should receive validated input with city');
	});
});



import { FileBucketSnapshotStorage } from './file-bucket-snapshot-storage.js';
import { FileBucket } from '@aws-blocks/bb-file-bucket';

describe('FileBucketSnapshotStorage', () => {
	const scope = new Scope('test-snap');
	const bucket = new FileBucket(scope, 'sessions');
	const storage = new FileBucketSnapshotStorage(bucket);

	const location = { sessionId: 'sess-1', scope: 'agent' as const, scopeId: 'default' };
	const snapshot = { data: { messages: [{ role: 'user', content: [{ text: 'hello' }] }], state: {}, systemPrompt: 'test' }, schemaVersion: '1.0', createdAt: new Date().toISOString() };

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
		await storage.saveManifest({ location: loc, manifest: { schemaVersion: '1.0', updatedAt: new Date().toISOString() } });
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
	test('onError is called when error chunk arrives', async () => {
		let chunkHandler: (chunk: any) => void;
		let errorReceived: string | undefined;
		const loadingStates: boolean[] = [];

		const chat = useChat({
			api: {
				sendMessage: async () => {},
				createConversation: async () => ({ conversationId: 'conv-1' }),
				getConversation: async () => ({ messages: [] }),
			},
			subscribe: async (_channelId, handler) => {
				chunkHandler = handler;
				return { unsubscribe() {}, established: Promise.resolve() };
			},
			onLoadingChange: (l) => { loadingStates.push(l); },
			onError: (err) => { errorReceived = err; },
		});

		await chat.sendMessage('hello');
		// Simulate error chunk from server
		chunkHandler!({ type: 'error', error: 'model throttled' });

		assert.strictEqual(errorReceived, 'model throttled');
		assert.strictEqual(loadingStates.at(-1), false, 'loading should be false after error');
	});

	test('onInterrupt is called when interrupt chunk arrives', async () => {
		let chunkHandler: (chunk: any) => void;
		let interruptsReceived: any[] | undefined;
		const loadingStates: boolean[] = [];

		const chat = useChat({
			api: {
				sendMessage: async () => {},
				createConversation: async () => ({ conversationId: 'conv-1' }),
				getConversation: async () => ({ messages: [] }),
			},
			subscribe: async (_channelId, handler) => {
				chunkHandler = handler;
				return { unsubscribe() {}, established: Promise.resolve() };
			},
			onLoadingChange: (l) => { loadingStates.push(l); },
			onInterrupt: (interrupts) => { interruptsReceived = interrupts; },
		});

		await chat.sendMessage('hello');
		chunkHandler!({ type: 'interrupt', interrupts: [{ id: 'int-1', name: 'approve:deleteRecords', reason: { tool: 'deleteRecords' } }] });

		assert.ok(interruptsReceived, 'onInterrupt should be called');
		assert.strictEqual(interruptsReceived!.length, 1);
		assert.strictEqual(interruptsReceived![0].name, 'approve:deleteRecords');
		assert.strictEqual(loadingStates.at(-1), false, 'loading should be false after interrupt');
	});

	test('respondToInterrupt calls api.resume and adds approval message', async () => {
		let chunkHandler: (chunk: any) => void;
		let resumeCalled = false;
		let resumeArgs: any;

		const chat = useChat({
			api: {
				sendMessage: async () => {},
				createConversation: async () => ({ conversationId: 'conv-1' }),
				getConversation: async () => ({ messages: [] }),
				resume: async (channelId, responses, convId) => { resumeCalled = true; resumeArgs = { channelId, responses, convId }; },
			},
			subscribe: async (_channelId, handler) => {
				chunkHandler = handler;
				return { unsubscribe() {}, established: Promise.resolve() };
			},
		});

		await chat.sendMessage('hello');
		chunkHandler!({ type: 'interrupt', interrupts: [{ id: 'int-1', name: 'approve:delete' }] });
		await chat.respondToInterrupt([{ interruptId: 'int-1', approved: true }]);

		assert.ok(resumeCalled, 'api.resume should be called');
		assert.strictEqual(resumeArgs.responses[0].approved, true);
		// Approval message should be in messages
		const messages = chat.getMessages();
		assert.ok(messages.some(m => m.role === 'approval' && m.content === 'Approved'), 'should have approval message');
	});

	test('respondToInterrupt throws if api.resume not configured', async () => {
		let chunkHandler: (chunk: any) => void;

		const chat = useChat({
			api: {
				sendMessage: async () => {},
				createConversation: async () => ({ conversationId: 'conv-1' }),
				getConversation: async () => ({ messages: [] }),
			},
			subscribe: async (_channelId, handler) => {
				chunkHandler = handler;
				return { unsubscribe() {}, established: Promise.resolve() };
			},
		});

		await chat.sendMessage('hello');
		chunkHandler!({ type: 'interrupt', interrupts: [{ id: 'int-1', name: 'approve:delete' }] });
		await assert.rejects(() => chat.respondToInterrupt([{ interruptId: 'int-1', approved: true }]), /api.resume/);
	});

	test('interrupt removes empty assistant placeholder', async () => {
		let chunkHandler: (chunk: any) => void;
		let lastMessages: any[] = [];

		const chat = useChat({
			api: {
				sendMessage: async () => {},
				createConversation: async () => ({ conversationId: 'conv-1' }),
				getConversation: async () => ({ messages: [] }),
			},
			subscribe: async (_channelId, handler) => {
				chunkHandler = handler;
				return { unsubscribe() {}, established: Promise.resolve() };
			},
			onMessagesChange: (msgs) => { lastMessages = msgs; },
		});

		await chat.sendMessage('hello');
		// At this point there's a user message + empty assistant placeholder
		assert.ok(lastMessages.some(m => m.role === 'assistant' && m.content === ''), 'should have empty placeholder');
		// Interrupt arrives — placeholder should be removed
		chunkHandler!({ type: 'interrupt', interrupts: [{ id: 'int-1', name: 'approve:delete' }] });
		assert.ok(!lastMessages.some(m => m.role === 'assistant' && m.content === ''), 'empty placeholder should be removed');
	});
});

describe('checkModelHealth', () => {
	const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => log } as any;

	test('canned provider is always healthy', async () => {
		assert.strictEqual(await checkModelHealth({ provider: 'canned' }, log), true);
	});

	test('bedrock foundation model found returns true', async () => {
		const mockClient = { send: async () => ({ modelDetails: { modelId: 'anthropic.claude-3-haiku' } }) };
		assert.strictEqual(await checkModelHealth({ provider: 'bedrock', modelId: 'anthropic.claude-3-haiku' }, log, mockClient), true);
	});

	test('bedrock foundation model not found returns false', async () => {
		const err = new Error('not found'); err.name = 'ValidationException';
		const mockClient = { send: async () => { throw err; } };
		assert.strictEqual(await checkModelHealth({ provider: 'bedrock', modelId: 'bad.model' }, log, mockClient), false);
	});

	test('bedrock credential error returns false', async () => {
		const err = new Error('no creds'); err.name = 'CredentialsProviderError';
		const mockClient = { send: async () => { throw err; } };
		assert.strictEqual(await checkModelHealth({ provider: 'bedrock', modelId: 'anthropic.claude-3-haiku' }, log, mockClient), false);
	});

	test('bedrock cross-region inference profile found returns true', async () => {
		const mockClient = { send: async () => ({ inferenceProfileName: 'US Claude Sonnet' }) };
		assert.strictEqual(await checkModelHealth({ provider: 'bedrock', modelId: 'us.anthropic.claude-sonnet-4' }, log, mockClient), true);
	});

	test('bedrock cross-region inference profile error returns false', async () => {
		const err = new Error('access denied'); err.name = 'AccessDeniedException';
		const mockClient = { send: async () => { throw err; } };
		assert.strictEqual(await checkModelHealth({ provider: 'bedrock', modelId: 'us.anthropic.claude-sonnet-4' }, log, mockClient), false);
	});

	test('openai-api with unreachable endpoint returns false', async () => {
		assert.strictEqual(await checkModelHealth({ provider: 'openai-api', modelId: 'gpt-4', endpoint: 'http://localhost:19999/v1' }, log), false);
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
			const warned = warnings.find(w => w.meta && 'bodySnippet' in w.meta);
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
				{ provider: 'openai-api', modelId: 'test-model', endpoint: `http://localhost:${port}/v1`, apiKey: 'sk-explicit' },
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
				{ provider: 'openai-api', modelId: 'test-model', endpoint: `http://localhost:${port}/v1`, apiKey: () => Promise.resolve('sk-from-resolver') },
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
			assert.strictEqual(config.endpoint, 'http://localhost:11434/v1', `${name} should use default Ollama endpoint`);
		}
	});
});
