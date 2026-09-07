// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import type { api as apiType } from 'aws-blocks';
import { createChat, realtimeTransport } from '@aws-blocks/bb-agent/client';
import type { AgentStreamChunk, ChatMessage, CreateChatOptions } from '@aws-blocks/bb-agent/client';
import type { RealtimeSubscription } from '@aws-blocks/bb-realtime';
import { codePoller } from './poll-for-code.js';

/**
 * Build the Realtime transport wired to the canned agent's RPCs — the copy-paste
 * boilerplate an app writes once per runtime. This is what `createChat` streams over.
 */
function cannedTransport(api: typeof apiType) {
  return realtimeTransport({
    subscribe: async (channelId, handlerOrOptions) => {
      const { channel } = await api.cannedGetChannel(channelId);
      // channel.subscribe is overloaded (bare handler | options object). Branch on the
      // shape so each arm narrows to one overload and the options form reaches the channel.
      return typeof handlerOrOptions === 'function'
        ? channel.subscribe(handlerOrOptions)
        : channel.subscribe(handlerOrOptions);
    },
    sendMessage: async (channelId, message, conversationId) => {
      await api.cannedStream(message, conversationId ?? undefined, channelId);
    },
    resume: async (channelId, responses, conversationId) => {
      await api.cannedResume(
        channelId,
        responses.map(r => ({ interruptId: r.interruptId, approved: r.approved ?? false })),
        conversationId ?? undefined,
      );
    },
  });
}

/**
 * Poll `predicate` until true or `ms` elapses, rejecting with `label` on timeout.
 * Mirrors the existing waitForMessages helper; keeps the createChat tests free of
 * repeated setInterval/setTimeout timer plumbing.
 */
function waitUntil(predicate: () => boolean, ms: number, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { clearInterval(check); reject(new Error(label)); }, ms);
    const check = setInterval(() => {
      if (predicate()) { clearTimeout(timer); clearInterval(check); resolve(); }
    }, 200);
  });
}

/**
 * Build a createChat wired to the canned agent for a fixed conversationId — the
 * api adapter (createConversation / getConversation / getPendingInterrupts) is
 * identical across the createChat tests, so each test only passes its own on*
 * callbacks via `handlers`.
 */
function cannedChat(
  api: typeof apiType,
  conversationId: string,
  handlers: Partial<Pick<CreateChatOptions, 'onChunk' | 'onInterrupt' | 'onMessagesChange' | 'onLoadingChange' | 'onError'>>,
) {
  return createChat({
    transport: cannedTransport(api),
    api: {
      createConversation: async () => ({ conversationId }),
      getConversation: async (id) => await api.cannedGetConversation(id),
      getPendingInterrupts: (id) => api.cannedGetPendingInterrupts(id),
    },
    ...handlers,
  });
}

/** Poll getConversation until expected message count is reached or timeout. */
async function waitForMessages(api: typeof apiType, conversationId: string, expectedCount: number, timeoutMs = 60000, useCanned = false): Promise<any[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { messages } = useCanned ? await api.cannedGetConversation(conversationId) : await api.agentGetConversation(conversationId);
    if (messages.length >= expectedCount) return messages;
    await new Promise(r => setTimeout(r, 500));
  }
  const { messages } = useCanned ? await api.cannedGetConversation(conversationId) : await api.agentGetConversation(conversationId);
  return messages;
}

/**
 * Sign up a user and confirm it with the verification code delivered for that
 * username. The agent per-user isolation test needs two distinct signed-in
 * users, so the code has to be matched to the right one.
 */
async function signUpAndConfirm(api: typeof apiType, username: string, password: string): Promise<void> {
  await api.authSignUp(username, password);
  const delivered = await codePoller('authGetLastCode', (u) => api.authGetLastCode(u))(username);
  await api.authConfirmSignUp(username, delivered.code);
}

export function agentTests(getApi: () => typeof apiType) {
  describe('Agent BB', () => {

    describe('Streaming', () => {
      test('stream returns channelId immediately', async () => {
        const api = getApi();
        const result = await api.agentStream('Say hello');
        assert.ok(result.channelId, 'should return a channelId');
      });

      test('getChannel returns a subscribable Realtime channel handle', async () => {
        const api = getApi();
        const result = await api.agentStream('Say hello');
        const { channel } = await api.agentGetChannel(result.channelId);
        assert.ok(channel, 'should return a channel handle');
        assert.strictEqual(typeof channel.subscribe, 'function', 'channel should have subscribe method');
      });

      test('subscription receives streaming chunks', { timeout: 60_000 }, async () => {
        const api = getApi();
        const { conversationId } = await api.agentCreateConversationId();
        // Subscribe BEFORE sending, await established before stream
        const { channel } = await api.agentGetChannel(conversationId);
        const chunks: any[] = [];
        const done = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('No done chunk within 60s')), 60_000);
          const sub = channel.subscribe((chunk: any) => {
            chunks.push(chunk);
            if (chunk.type === 'done') { clearTimeout(timer); resolve(); }
          });
          sub.established
            .then(() => api.agentStream('Say hello', conversationId, conversationId))
            .catch(reject);
        });
        await done;
        assert.ok(chunks.filter((c: any) => c.type === 'text-delta').length > 0, 'should receive text-delta chunks');
        assert.ok(chunks.some((c: any) => c.type === 'done'), 'should receive done chunk');
      });

      test('agentGetRawDescriptor returns a fresh, well-formed chunks-channel descriptor', async () => {
        const api = getApi();
        const { conversationId } = await api.agentCreateConversationId();

        const d1 = await api.agentGetRawDescriptor(conversationId);
        // __blocks is stripped so the response middleware does NOT hydrate this into a
        // subscribe-only channel client — the raw token fields must be reachable.
        assert.ok(!('__blocks' in d1), 'raw descriptor must have __blocks stripped');
        assert.strictEqual(typeof d1.token, 'string', 'descriptor carries a channel token');
        assert.ok((d1.token as string).length > 0, 'channel token is non-empty');
        const channel1 = d1.channel;
        // The descriptor targets the AGENT chunks channel for this conversation.
        assert.ok(typeof channel1 === 'string' && channel1.includes(conversationId), 'channel path targets the conversation');

        // Each call mints a FRESH channel token. The local mint bakes exp=floor(now/1000)
        // into the token, so a >1s gap guarantees a distinct token (deterministic in both
        // local mint and the deployed authorizer, which are also exp-based).
        await new Promise(r => setTimeout(r, 1100));
        const d2 = await api.agentGetRawDescriptor(conversationId);
        assert.notStrictEqual(d2.token, d1.token, 'each call mints a fresh channel token');
      });

      test('reconnect on the agent chunks channel invokes refresh and resubscribes', { timeout: 60_000 }, async () => {
        const api = getApi();
        const { conversationId } = await api.agentCreateConversationId();
        // Subscribe via the SAME path useChat uses (agentGetChannel → hydrated chunks channel).
        const { channel } = await api.agentGetChannel(conversationId);

        const chunks: any[] = [];
        let reconnects = 0;
        let refreshCalls = 0;

        // Mirror realtime.test.ts's refresh callback, sourced from the AGENT's chunks
        // channel: agentGetRawDescriptor mints a FRESH token server-side and strips
        // __blocks so the response middleware won't hydrate it; we re-add the discriminant.
        // `channel` is set to the concrete conversationId string to satisfy the descriptor's
        // `channel: string` cast-free (the raw descriptor's channel is typed `unknown`).
        const sub = channel.subscribe({
          onMessage: (chunk: any) => { chunks.push(chunk); },
          onReconnect: () => { reconnects++; },
          refresh: async () => {
            refreshCalls++;
            const fresh = await api.agentGetRawDescriptor(conversationId);
            return { ...fresh, __blocks: 'realtime/channel', channel: conversationId };
          },
        } satisfies import('aws-blocks').SubscribeOptions<any>);

        try {
          await sub.established;
          // Start a stream (canned provider in local) so the subscription is live mid-turn.
          await api.agentStream('Say hello', conversationId, conversationId);

          // Wait for at least one chunk — proves delivery on the agent channel pre-drop.
          const chunkDeadline = Date.now() + 30_000;
          while (chunks.length < 1) {
            if (Date.now() > chunkDeadline) throw new Error('no chunk delivered on the agent channel within 30s');
            await new Promise(r => setTimeout(r, 100));
          }

          // Force a mid-stream drop of the underlying socket. Because a refresh fn is
          // registered, the transport must invoke it before reopening, then resubscribe
          // the chunks channel and fire onReconnect.
          sub.connection?.close();

          const reconnectDeadline = Date.now() + 60_000;
          while (reconnects < 1) {
            if (Date.now() > reconnectDeadline) throw new Error('onReconnect did not fire within 60s of the forced close on the agent channel');
            await new Promise(r => setTimeout(r, 100));
          }

          // PR503 assertion: the refresh path IS exercised on the AGENT chunks channel —
          // agentGetRawDescriptor is invoked to re-mint credentials before the reconnect.
          // (Post-reconnect transport-level delivery with fresh creds is covered by the
          // realtime.test.ts refresh e2e — same transport + refresh mechanism.)
          assert.ok(refreshCalls >= 1, `refresh callback should be invoked on the agent-channel reconnect, got ${refreshCalls}`);
          assert.ok(reconnects >= 1, 'onReconnect should fire on the agent channel after the forced close');
        } finally {
          sub.unsubscribe();
        }
      });
    });

    describe('Conversation Persistence', () => {
      test('create conversation', async () => {
        const api = getApi();
        const result = await api.agentCreateConversationId();
        assert.ok(result.conversationId);
      });

      test('messages persist after stream', async () => {
        const api = getApi();
        const { conversationId } = await api.agentCreateConversationId();
        await api.agentStream('Hello', conversationId);

        // Poll until messages are persisted (agent runs async)
        const messages = await waitForMessages(api, conversationId, 2);
        assert.strictEqual(messages.length, 2, 'should have user + assistant');
        assert.strictEqual(messages[0].role, 'user');
        assert.strictEqual(messages[0].content, 'Hello');
        assert.strictEqual(messages[1].role, 'assistant');
        assert.ok(messages[1].content.length > 0, 'assistant should have content');
      });

      test('messages are returned in order', async () => {
        const api = getApi();
        const { conversationId } = await api.agentCreateConversationId();
        await api.agentStream('First', conversationId);
        const messages1 = await waitForMessages(api, conversationId, 2);
        assert.strictEqual(messages1[0].content, 'First');

        await api.agentStream('Second', conversationId);
        const messages2 = await waitForMessages(api, conversationId, 4);
        assert.strictEqual(messages2[0].content, 'First');
        assert.strictEqual(messages2[2].content, 'Second');
      });

      test('multi-turn conversation', async () => {
        const api = getApi();
        const { conversationId } = await api.agentCreateConversationId();
        await api.agentStream('First message', conversationId);
        await waitForMessages(api, conversationId, 2);

        await api.agentStream('Second message', conversationId);
        const messages = await waitForMessages(api, conversationId, 4);
        assert.strictEqual(messages.length, 4, 'should have 4 messages (2 turns)');
      });

      test('delete conversation', async () => {
        const api = getApi();
        const { conversationId } = await api.agentCreateConversationId();
        await api.agentStream('Hello', conversationId);
        await waitForMessages(api, conversationId, 2);

        await api.agentDeleteConversation(conversationId);
        const { messages } = await api.agentGetConversation(conversationId);
        assert.strictEqual(messages.length, 0, 'should have no messages after delete');
      });

      test('list conversations', async () => {
        const api = getApi();
        const { conversationId: id1 } = await api.agentCreateConversationId();
        const { conversationId: id2 } = await api.agentCreateConversationId();

        const { conversations } = await api.agentListConversations();
        const ids = conversations.map((c: any) => c.conversationId);
        assert.ok(ids.includes(id1), 'should include first conversation');
        assert.ok(ids.includes(id2), 'should include second conversation');

        // Clean up
        await api.agentDeleteConversation(id1);
        await api.agentDeleteConversation(id2);
      });
    });

    describe('Inference Only', () => {
      test('inferenceOnly agent returns channelId', async () => {
        const api = getApi();
        const result = await api.agentInferenceOnly('Say hello');
        assert.ok(result.channelId, 'should return a channelId');
      });
    });

    // TODO: Realtime streaming e2e — test when useChat() hook is built (M7)
    // TODO: Token usage — delivered via Realtime done chunk, test with useChat()

    describe('Tool Calling', () => {
      test('tool call persists to conversation history', async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();
        await api.cannedStream('use kvWrite', conversationId, conversationId);

        // Tool calls produce 4 messages: user, tool-call, tool-result, assistant
        const messages = await waitForMessages(api, conversationId, 4, 60000, true);
        const roles = messages.map((m: any) => m.role);
        assert.ok(roles.includes('user'), 'should have user message');
        assert.ok(roles.includes('tool-call'), 'should have tool-call message');
        assert.ok(roles.includes('tool-result'), 'should have tool-result message');
        assert.ok(roles.includes('assistant'), 'should have assistant message');

        const toolResult = messages.find((m: any) => m.role === 'tool-result');
        assert.ok(toolResult, 'should have tool-result message');
        const meta = toolResult!.metadata;
        assert.ok(meta.toolName === 'kvWrite', 'tool result should reference the tool name');
      });
    });

    describe('Tool uses another BB', () => {
      test('tool handler can call KV store', async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();
        await api.cannedStream('Please run kvWrite now', conversationId);
        const messages = await waitForMessages(api, conversationId, 4, 10000, true);
        const toolResult = messages.find((m: any) => m.role === 'tool-result');
        assert.ok(toolResult, 'should have tool-result');
        // Verify the KV store was actually written to
        const value = await api.kvGet('agent-test');
        assert.strictEqual(value, 'hello', 'KV store should contain the value written by the tool');
      });
    });

    describe('Tool Context', () => {
      test('per-call context reaches the tool handler', async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();
        await api.cannedStream('Please run whoAmI now', conversationId);
        const messages = await waitForMessages(api, conversationId, 4, 10000, true);
        const toolResult = messages.find((m: any) => m.role === 'tool-result');
        assert.ok(toolResult, 'should have tool-result');
        // The whoAmI tool writes the context userId to the KV store
        const value = await api.kvGet('agent-whoami');
        assert.strictEqual(value, 'test-user', 'tool context userId should be threaded into the handler');
      });
    });

    describe('Model Fallback', () => {
      test('agent falls through to next candidate when first model is unreachable', { timeout: 10_000 }, async () => {
        const api = getApi();
        const { channelId } = await api.fallbackStream('hello');
        assert.ok(channelId, 'should return a channelId — agent resolved to canned fallback');
      });
    });


    describe('Long-Running Agent (>29s)', () => {
      test('agent with slow tool completes beyond API Gateway timeout', async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();
        await api.cannedStream('Use the slowTask now.', conversationId);

        const messages = await waitForMessages(api, conversationId, 4, 90000, true);
        assert.ok(messages.length >= 4, 'should have all messages after slow tool completes');
        const toolResult = messages.find((m: any) => m.role === 'tool-result');
        assert.ok(toolResult, 'should have tool-result');
        const meta = toolResult!.metadata;
        assert.ok(meta.toolName === 'slowTask', 'tool result should reference slowTask');
      });
    });
    describe('Conversation Isolation', () => {
      test('different conversations do not share messages', async () => {
        const api = getApi();
        const { conversationId: conv1 } = await api.agentCreateConversationId();
        const { conversationId: conv2 } = await api.agentCreateConversationId();

        await api.agentStream('Message for conv1', conv1);
        await api.agentStream('Message for conv2', conv2);

        const msgs1 = await waitForMessages(api, conv1, 2);
        const msgs2 = await waitForMessages(api, conv2, 2);

        assert.strictEqual(msgs1.length, 2, 'conv1 should have 2 messages');
        assert.strictEqual(msgs2.length, 2, 'conv2 should have 2 messages');
        assert.ok(msgs1[0].content.includes('conv1'), 'conv1 should have its own message');
        assert.ok(msgs2[0].content.includes('conv2'), 'conv2 should have its own message');
      });
    });

    describe('Auth-Scoped Conversations', () => {
      test('conversations are scoped to the authenticated user', async () => {
        const api = getApi();

        // Sign up and sign in as user A
        const userA = `agent-test-a-${Date.now()}`;
        await signUpAndConfirm(api, userA, 'password123');
        await api.authSignIn(userA, 'password123');

        // Create a conversation as user A
        const { conversationId } = await api.agentCreateConversationId();
        const listA = await api.agentListConversations();
        const idsA = listA.conversations.map((c: any) => c.conversationId);
        assert.ok(idsA.includes(conversationId), 'user A should see their conversation');

        // Sign out, sign up and sign in as user B
        await api.authSignOut();
        const userB = `agent-test-b-${Date.now()}`;
        await signUpAndConfirm(api, userB, 'password123');
        await api.authSignIn(userB, 'password123');

        // User B should NOT see user A's conversation
        const listB = await api.agentListConversations();
        const idsB = listB.conversations.map((c: any) => c.conversationId);
        assert.ok(!idsB.includes(conversationId), 'user B should NOT see user A conversation');

        // Clean up
        await api.authSignOut();
      });
    });

    describe('Error Handling', () => {
      test('getConversation throws on inferenceOnly agent', async () => {
        const api = getApi();
        await assert.rejects(
          () => api.agentInferenceOnlyGetConversation('test'),
          (err: any) => err.message.includes('persistence'),
        );
      });

      test('deleteConversation throws on inferenceOnly agent', async () => {
        const api = getApi();
        await assert.rejects(
          () => api.agentInferenceOnlyDeleteConversation('test'),
          (err: any) => err.message.includes('persistence'),
        );
      });

      test('getConversation returns empty for unknown conversationId', async () => {
        const api = getApi();
        const { messages } = await api.agentGetConversation('nonexistent-id');
        assert.strictEqual(messages.length, 0, 'should return empty array');
      });

      test('delete conversation that does not exist is silent', async () => {
        const api = getApi();
        // Should not throw
        await api.agentDeleteConversation('nonexistent-id');
      });
    });

    describe('API Key Resolver', () => {
      test('AppSetting secret resolves via () => Promise<string> pattern', async () => {
        const api = getApi();
        const { resolved } = await api.agentTestApiKeyResolver();
        assert.ok(resolved, 'secret setting should resolve through async resolver');
      });
    });

    describe('Error Propagation', () => {
      test('tool error is captured in conversation history', async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();
        await api.cannedStream('Please run the failingTool', conversationId);

        // Strands catches tool errors and sends them back to the model as error ToolResultBlocks.
        // CannedProvider responds with the error text. Expect: user, tool-call, tool-result, assistant.
        const messages = await waitForMessages(api, conversationId, 4, 60000, true);
        assert.ok(messages.length >= 4, 'should have user + tool-call + tool-result + assistant');
        const assistant = messages.find((m: any) => m.role === 'assistant');
        assert.ok(assistant, 'should have assistant response');
        assert.ok(assistant!.content.toLowerCase().includes('error') || assistant!.content.toLowerCase().includes('fail'),
          'assistant response should mention the error');
      });
    });

    describe('Bedrock Model Presets', () => {
      for (const presetName of ['BALANCED', 'SMART', 'FAST']) {
        test(`preset ${presetName} returns a response`, { timeout: 30_000 }, async () => {
          const api = getApi();
          const { text } = await api.agentPresetStream(presetName, 'hi');
          assert.ok(text && text.length > 0, `${presetName} should return a non-empty response`);
        });
      }
    });

    describe('HITL — Tool Approval (deterministic)', () => {
      test('interrupt chunk arrives for tool with approval: always', { timeout: 15_000 }, async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();
        const { channel } = await api.cannedGetChannel(conversationId);

        const chunks: any[] = [];
        const interrupted = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('No interrupt chunk within 10s')), 10_000);
          const sub = channel.subscribe((chunk: any) => {
            chunks.push(chunk);
            if (chunk.type === 'interrupt') { clearTimeout(timer); resolve(); }
          });
          sub.established.then(() => {
            api.cannedStream('use deleteRecords', conversationId, conversationId);
          }).catch(reject);
        });

        await interrupted;
        const interruptChunk = chunks.find((c: any) => c.type === 'interrupt');
        assert.ok(interruptChunk, 'should receive interrupt chunk');
        assert.ok(interruptChunk.interrupts.length > 0, 'should have pending interrupts');
        assert.ok(interruptChunk.interrupts[0].name.includes('deleteRecords'), 'interrupt should reference deleteRecords');
      });

      test('resume after approval completes the agent turn', { timeout: 20_000 }, async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();
        const { channel } = await api.cannedGetChannel(conversationId);

        const chunks: any[] = [];
        const done = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('No done chunk within 15s')), 15_000);
          const sub = channel.subscribe((chunk: any) => {
            chunks.push(chunk);
            if (chunk.type === 'done') { clearTimeout(timer); resolve(); }
          });
          sub.established.then(async () => {
            await api.cannedStream('use deleteRecords', conversationId, conversationId);
            // Wait for interrupt to arrive
            await new Promise(r => setTimeout(r, 1000));
            const { interrupts } = await api.cannedGetPendingInterrupts(conversationId);
            if (interrupts.length) {
              await api.cannedResume(conversationId, interrupts.map((i: any) => ({ interruptId: i.id, approved: true })), conversationId);
            }
          }).catch(reject);
        });

        await done;
        assert.ok(chunks.some((c: any) => c.type === 'interrupt'), 'should have received interrupt');
        assert.ok(chunks.some((c: any) => c.type === 'done'), 'should have received done after resume');
      });

      test('approval is persisted to conversation history', { timeout: 20_000 }, async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();
        const { channel } = await api.cannedGetChannel(conversationId);

        const interruptReceived = new Promise<any>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('No interrupt within 10s')), 10_000);
          const sub = channel.subscribe((chunk: any) => {
            if (chunk.type === 'interrupt') { clearTimeout(timer); resolve(chunk); }
          });
          sub.established.then(() => {
            api.cannedStream('use deleteRecords', conversationId, conversationId);
          }).catch(reject);
        });

        const interruptChunk = await interruptReceived;
        await api.cannedResume(conversationId, interruptChunk.interrupts.map((i: any) => ({ interruptId: i.id, approved: true })), conversationId);
        // Wait for agent to complete
        await new Promise(r => setTimeout(r, 2000));

        const { messages } = await api.cannedGetConversation(conversationId);
        const roles = messages.map((m: any) => m.role);
        assert.ok(roles.includes('interrupt'), 'should have interrupt message in history');
        assert.ok(roles.includes('approval'), 'should have approval message in history');
      });

      test('denial skips tool execution and agent continues', { timeout: 60_000 }, async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();
        const { channel } = await api.cannedGetChannel(conversationId);

        const chunks: any[] = [];
        const done = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('No done chunk within 15s')), 15_000);
          const sub = channel.subscribe((chunk: any) => {
            chunks.push(chunk);
            if (chunk.type === 'done') { clearTimeout(timer); resolve(); }
          });
          sub.established.then(async () => {
            await api.cannedStream('use deleteRecords', conversationId, conversationId);
            await new Promise(r => setTimeout(r, 1000));
            const { interrupts } = await api.cannedGetPendingInterrupts(conversationId);
            if (interrupts.length) {
              await api.cannedResume(conversationId, interrupts.map((i: any) => ({ interruptId: i.id, approved: false })), conversationId);
            }
          }).catch(reject);
        });

        await done;
        assert.ok(chunks.some((c: any) => c.type === 'interrupt'), 'should have received interrupt');
        assert.ok(chunks.some((c: any) => c.type === 'done'), 'agent should complete after denial');
        // After denial, conversation history should show the tool was cancelled (not executed successfully)
        const { messages } = await api.cannedGetConversation(conversationId);
        const toolResult = messages.find((m: any) => m.role === 'tool-result');
        assert.ok(toolResult, 'should have tool-result message');
        const output = toolResult.metadata.toolOutput;
        assert.ok(JSON.stringify(output).includes('denied'), 'tool-result should contain denial message');
      });
    });

    describe('createChat (compute-agnostic client API)', () => {
      test('sendMessage streams a reply into the assistant message', { timeout: 30_000 }, async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();

        const chunks: AgentStreamChunk[] = [];
        const chat = createChat({
          transport: cannedTransport(api),
          api: {
            createConversation: async () => ({ conversationId }),
            getConversation: async (id) => await api.cannedGetConversation(id),
            getPendingInterrupts: (id) => api.cannedGetPendingInterrupts(id),
          },
          onChunk: (chunk) => chunks.push(chunk),
        });

        const done = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('No done chunk within 25s')), 25_000);
          const check = setInterval(() => {
            if (chunks.some(c => c.type === 'done')) { clearTimeout(timer); clearInterval(check); resolve(); }
          }, 200);
        });

        await chat.sendMessage('Say hello');
        await done;

        assert.ok(chunks.some(c => c.type === 'text-delta'), 'should receive text-delta chunks');
        assert.ok(chunks.some(c => c.type === 'done'), 'should receive a done chunk');
        const assistant = chat.getMessages().find(m => m.role === 'assistant');
        assert.ok(assistant && assistant.content.length > 0, 'assistant message should accumulate streamed text');
        assert.strictEqual(chat.isLoading(), false, 'loading clears on done');
        chat.destroy();
      });

      test('interrupt surfaces via onInterrupt and sendMessage({ interruptResponses }) resumes', { timeout: 30_000 }, async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();

        const chunks: AgentStreamChunk[] = [];
        let interrupts: Array<{ interruptId: string; name: string; reason?: unknown }> = [];
        const chat = createChat({
          transport: cannedTransport(api),
          api: {
            createConversation: async () => ({ conversationId }),
            getConversation: async (id) => await api.cannedGetConversation(id),
            getPendingInterrupts: (id) => api.cannedGetPendingInterrupts(id),
          },
          onChunk: (chunk) => chunks.push(chunk),
          onInterrupt: (ints) => { interrupts = ints; },
        });

        const interrupted = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('No interrupt within 15s')), 15_000);
          const check = setInterval(() => {
            if (interrupts.length) { clearTimeout(timer); clearInterval(check); resolve(); }
          }, 200);
        });

        await chat.sendMessage('use deleteRecords');
        await interrupted;
        assert.ok(interrupts[0].name.includes('deleteRecords'), 'interrupt should reference the tool');

        const completed = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('No done chunk after resume within 15s')), 15_000);
          const check = setInterval(() => {
            if (chunks.some(c => c.type === 'done')) { clearTimeout(timer); clearInterval(check); resolve(); }
          }, 200);
        });

        await chat.sendMessage({ interruptResponses: interrupts.map(i => ({ interruptId: i.interruptId, approved: true })) });
        await completed;

        assert.ok(chunks.some(c => c.type === 'done'), 'resume should complete the turn');
        assert.ok(chat.getMessages().some(m => m.role === 'approval'), 'approval decision recorded in the chat');
        chat.destroy();
      });

      test('loadConversation rehydrates history and projects approval metadata', { timeout: 30_000 }, async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();

        // First chat: run a turn, hit the approval interrupt, approve it. This
        // persists an `approval` message (with decision metadata) to history.
        let interrupts: Array<{ interruptId: string; name: string; reason?: unknown }> = [];
        const chunks: AgentStreamChunk[] = [];
        const first = cannedChat(api, conversationId, {
          onChunk: (chunk) => chunks.push(chunk),
          onInterrupt: (ints) => { interrupts = ints; },
        });
        await first.sendMessage('use deleteRecords');
        await waitUntil(() => interrupts.length > 0, 15_000, 'No interrupt within 15s');
        await first.sendMessage({ interruptResponses: interrupts.map(i => ({ interruptId: i.interruptId, approved: true })) });
        await waitUntil(() => chunks.some(c => c.type === 'done'), 15_000, 'No done after resume within 15s');
        first.destroy();

        // Second chat, fresh instance: load the SAME conversation and assert the
        // history rehydrates. The customer passes canned metadata straight through
        // (getConversation returns `unknown`); loadConversation projects it through
        // asJSONRecord into the message list.
        let loaded: ChatMessage[] = [];
        const second = cannedChat(api, conversationId, {
          onMessagesChange: (msgs) => { loaded = msgs; },
        });
        await second.loadConversation(conversationId);

        assert.ok(loaded.length > 0, 'loadConversation should rehydrate the message list');
        assert.strictEqual(second.getConversationId(), conversationId, 'conversationId is set after load');
        const approval = loaded.find(m => m.role === 'approval');
        assert.ok(approval, 'approval message should be present in loaded history');
        // Asserts the persisted decision survives loadConversation's projection and is
        // readable as `metadata.approved`. (Note: the `/client` ChatMessage is currently
        // the flat interface from index.hooks.ts, so this is a value round-trip check,
        // not a compile-time discriminated-union narrowing proof — see the ChatMessage
        // de-dup follow-up.)
        assert.strictEqual(approval?.metadata?.approved, true, 'approval metadata.approved round-trips as true');
        second.destroy();
      });

      test('denying an interrupt continues the turn without executing the tool', { timeout: 30_000 }, async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();

        const chunks: AgentStreamChunk[] = [];
        let interrupts: Array<{ interruptId: string; name: string; reason?: unknown }> = [];
        const chat = cannedChat(api, conversationId, {
          onChunk: (chunk) => chunks.push(chunk),
          onInterrupt: (ints) => { interrupts = ints; },
        });

        await chat.sendMessage('use deleteRecords');
        await waitUntil(() => interrupts.length > 0, 15_000, 'No interrupt within 15s');

        // Deny (approved: false) — the turn should still complete, with the denial recorded.
        await chat.sendMessage({ interruptResponses: interrupts.map(i => ({ interruptId: i.interruptId, approved: false })) });
        await waitUntil(() => chunks.some(c => c.type === 'done'), 15_000, 'No done after denial within 15s');

        const denial = chat.getMessages().find(m => m.role === 'approval');
        assert.ok(denial, 'a decision message should be recorded on denial');
        assert.strictEqual(denial?.metadata?.approved, false, 'denial metadata.approved round-trips as false');
        assert.strictEqual(chat.isLoading(), false, 'loading clears after a denied turn completes');
        // The tool must NOT have run: the persisted tool-result records the denial
        // rather than a successful execution (mirrors the pre-existing denial test).
        const { messages: persisted } = await api.cannedGetConversation(conversationId);
        const toolResult = persisted.find((m) => m.role === 'tool-result');
        assert.ok(toolResult, 'a tool-result message should be persisted');
        assert.ok(
          JSON.stringify(toolResult?.metadata?.toolOutput).includes('denied'),
          'tool-result records the denial, proving the tool was not executed',
        );
        chat.destroy();
      });

      test('newConversation() clears messages and conversation id', { timeout: 30_000 }, async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();

        const chunks: AgentStreamChunk[] = [];
        const chat = cannedChat(api, conversationId, {
          onChunk: (chunk) => chunks.push(chunk),
        });

        await chat.sendMessage('Say hello');
        await waitUntil(() => chunks.some(c => c.type === 'done'), 25_000, 'No done within 25s');
        assert.ok(chat.getMessages().length > 0, 'messages accumulate during the turn');

        chat.newConversation();
        assert.strictEqual(chat.getMessages().length, 0, 'newConversation clears the message list');
        assert.strictEqual(chat.getConversationId(), null, 'newConversation clears the conversation id');
        assert.strictEqual(chat.isLoading(), false, 'newConversation is not loading');
        chat.destroy();
      });

      test('onMessagesChange fires as the assistant message streams in', { timeout: 30_000 }, async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();

        let latest: ChatMessage[] = [];
        let changeCount = 0;
        const chat = cannedChat(api, conversationId, {
          onMessagesChange: (msgs) => { latest = msgs; changeCount++; },
        });

        await chat.sendMessage('Say hello');
        await waitUntil(
          () => latest.some(m => m.role === 'assistant' && m.content.length > 0),
          25_000,
          'No assistant text within 25s',
        );

        assert.ok(changeCount > 0, 'onMessagesChange fires at least once');
        assert.ok(latest.some(m => m.role === 'user'), 'user message present in the rendered list');
        // (the assistant-with-content check is the waitUntil predicate above — not repeated here)
        chat.destroy();
      });
    });

    describe('createChat mid-turn reconnect (Option A e2e)', () => {
      // Exercises the FULL createChat -> real hydrated agent channel wiring end-to-end (the
      // unit tests mock the transport). Sends a message, forces a mid-turn socket drop, and
      // asserts the spinner clears and the final assistant text is recovered — mirroring the
      // transport-level reconnect test in realtime.test.ts, but through the createChat path so
      // a wiring regression (options object degrading to a bare handler, so onReconnect/
      // onDisconnect are dropped) would be caught.
      // Per-test timeout for the real-AWS reconnect round-trip (backoff + $connect + resubscribe).
      test('createChat recovers a mid-turn reconnect: loading clears and final text is restored', { timeout: 120_000 }, async () => {
        const api = getApi();
        const { conversationId } = await api.agentCreateConversationId();

        // Capture the live subscription so the test can force a transport drop. The
        // subscribe adapter records the handle bb-realtime returns (it exposes `.connection`).
        let sub: RealtimeSubscription | undefined;
        const messages: Array<{ role: string; content: string }> = [];

        const chat = createChat({
          // Mirror the app wiring in src/index.ts createChatForConvo, but capture `sub`.
          transport: realtimeTransport({
            subscribe: async (channelId, handlerOrOptions) => {
              const { channel } = await api.agentGetChannel(channelId);
              // channel.subscribe is overloaded (bare handler | options object). Branch on the
              // shape so each arm narrows to one overload and the options form (onReconnect/
              // onDisconnect) reaches the channel intact. Capture the handle to force a drop.
              sub = typeof handlerOrOptions === 'function'
                ? channel.subscribe(handlerOrOptions)
                : channel.subscribe(handlerOrOptions);
              return sub;
            },
            sendMessage: async (channelId, message, convId) => {
              await api.agentStream(message, convId ?? undefined, channelId);
            },
            resume: async (channelId, responses, convId) => {
              await api.agentResume(
                channelId,
                responses.map(r => ({ interruptId: r.interruptId, approved: r.approved ?? false })),
                convId ?? undefined,
              );
            },
          }),
          api: {
            createConversation: async () => ({ conversationId }),
            getConversation: async (id) => await api.agentGetConversation(id),
            getPendingInterrupts: async (id) => await api.agentGetPendingInterrupts(id),
          },
          onMessagesChange: (m) => {
            // Replace in place so the outer reference always reflects the latest render.
            messages.length = 0;
            for (const x of m) messages.push({ role: x.role, content: x.content });
          },
        });

        try {
          await chat.loadConversation(conversationId);
          await chat.sendMessage('Say hello');

          // Wait until the turn has started (loading true) so the drop is genuinely mid-turn.
          // Poll chat.isLoading() directly — TS narrows the method's boolean return.
          const startDeadline = Date.now() + 30_000;
          while (!chat.isLoading()) {
            if (Date.now() > startDeadline) throw new Error('turn did not start (loading never became true) within 30s');
            await new Promise((r) => setTimeout(r, 100));
          }

          // Force a mid-turn transport drop; the transport transparently reconnects and
          // resubscribes, and createChat re-syncs the final assistant text from getConversation
          // (or a live done chunk resolves it on the resubscribed channel).
          sub?.connection?.close();

          // The spinner MUST clear (via a live done chunk on the resubscribed channel, or the
          // reconnect re-sync from the DB) — this is the stuck-spinner failure the PR fixes.
          const clearDeadline = Date.now() + 90_000;
          while (chat.isLoading()) {
            if (Date.now() > clearDeadline) throw new Error('loading did not clear within 90s after the mid-turn drop');
            await new Promise((r) => setTimeout(r, 250));
          }
          assert.strictEqual(chat.isLoading(), false, 'loading cleared after the mid-turn reconnect');

          // The final assistant text is present and non-empty (recovered live or from the DB).
          const assistant = messages.find((m) => m.role === 'assistant');
          assert.ok(assistant, 'an assistant message should exist after the turn');
          assert.ok(assistant!.content.length > 0, 'final assistant text is recovered, not left empty');
          // The persisted conversation agrees (source of truth).
          const { messages: persisted } = await api.agentGetConversation(conversationId);
          assert.ok(
            persisted.some((m) => m.role === 'assistant' && m.content.length > 0),
            'the recovered assistant text is backed by the persisted conversation',
          );
        } finally {
          chat.destroy();
        }
      });
    });
  });
}
