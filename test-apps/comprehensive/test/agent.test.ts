// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import type { api as apiType } from 'aws-blocks';
import { createAgentCoreWsTransport } from '@aws-blocks/bb-agent/client';

// The direct browser→AgentCore WebSocket path only exists on a deployed runtime
// (wsAgentGetStreamEndpoint resolves a live runtime ARN); locally there's no runtime to
// connect to. Gate the WS long-running test to sandbox/production.
const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const isSandbox = ENV === 'sandbox' || ENV === 'production';

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

export function agentTests(getApi: () => typeof apiType) {
  describe('Agent BB', () => {

    describe('Streaming', () => {
      test('stream returns chunks with a done chunk', async () => {
        const api = getApi();
        const { chunks } = await api.agentStream('Say hello');
        assert.ok(chunks.some((c: any) => c.type === 'done'), 'should receive a done chunk');
      });

      test('stream yields streaming chunks', { timeout: 60_000 }, async () => {
        const api = getApi();
        const { conversationId } = await api.agentCreateConversationId();
        const { chunks } = await api.agentStream('Say hello', conversationId);
        assert.ok(chunks.filter((c: any) => c.type === 'text-delta').length > 0, 'should receive text-delta chunks');
        assert.ok(chunks.some((c: any) => c.type === 'done'), 'should receive done chunk');
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
      test('inferenceOnly agent returns chunks with a done chunk', async () => {
        const api = getApi();
        const { chunks } = await api.agentInferenceOnly('Say hello');
        assert.ok(chunks.some((c: any) => c.type === 'done'), 'should return a done chunk');
      });
    });

    // TODO: SSE streaming e2e — test when useChat() hook is built (M7)
    // TODO: Token usage — delivered via the SSE done chunk, test with useChat()

    describe('Tool Calling', () => {
      test('tool call persists to conversation history', async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();
        await api.cannedStream('use kvWrite', conversationId);

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
        const { chunks } = await api.fallbackStream('hello');
        assert.ok(chunks.some((c: any) => c.type === 'done'), 'should return a done chunk — agent resolved to canned fallback');
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
        await api.authSignUp(userA, 'password123');
        const codeA = await api.authGetLastCode();
        await api.authConfirmSignUp(userA, codeA!.code);
        await api.authSignIn(userA, 'password123');

        // Create a conversation as user A
        const { conversationId } = await api.agentCreateConversationId();
        const listA = await api.agentListConversations();
        const idsA = listA.conversations.map((c: any) => c.conversationId);
        assert.ok(idsA.includes(conversationId), 'user A should see their conversation');

        // Sign out, sign up and sign in as user B
        await api.authSignOut();
        const userB = `agent-test-b-${Date.now()}`;
        await api.authSignUp(userB, 'password123');
        const codeB = await api.authGetLastCode();
        await api.authConfirmSignUp(userB, codeB!.code);
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
        const { chunks } = await api.cannedStream('use deleteRecords', conversationId);

        const interruptChunk = chunks.find((c: any) => c.type === 'interrupt');
        assert.ok(interruptChunk, 'should receive interrupt chunk');
        assert.ok(interruptChunk.interrupts!.length > 0, 'should have pending interrupts');
        assert.ok(interruptChunk.interrupts![0].name.includes('deleteRecords'), 'interrupt should reference deleteRecords');
      });

      test('resume after approval completes the agent turn', { timeout: 20_000 }, async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();
        const { chunks } = await api.cannedStream('use deleteRecords', conversationId);
        const interruptChunk = chunks.find((c: any) => c.type === 'interrupt');
        assert.ok(interruptChunk, 'should have received interrupt');

        const { chunks: resumed } = await api.cannedResume(
          interruptChunk.interrupts!.map((i: any) => ({ interruptId: i.id, response: 'yes' })),
          conversationId,
        );
        assert.ok(resumed.some((c: any) => c.type === 'done'), 'should have received done after resume');
      });

      test('approval is persisted to conversation history', { timeout: 20_000 }, async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();
        const { chunks } = await api.cannedStream('use deleteRecords', conversationId);
        const interruptChunk = chunks.find((c: any) => c.type === 'interrupt');
        assert.ok(interruptChunk, 'should have received interrupt');

        await api.cannedResume(
          interruptChunk.interrupts!.map((i: any) => ({ interruptId: i.id, response: 'yes' })),
          conversationId,
        );

        const { messages } = await api.cannedGetConversation(conversationId);
        const roles = messages.map((m: any) => m.role);
        assert.ok(roles.includes('interrupt'), 'should have interrupt message in history');
        assert.ok(roles.includes('approval'), 'should have approval message in history');
      });

      test('denial skips tool execution and agent continues', { timeout: 60_000 }, async () => {
        const api = getApi();
        const { conversationId } = await api.cannedCreateConversationId();
        const { chunks } = await api.cannedStream('use deleteRecords', conversationId);
        const interruptChunk = chunks.find((c: any) => c.type === 'interrupt');
        assert.ok(interruptChunk, 'should have received interrupt');

        const { chunks: resumed } = await api.cannedResume(
          interruptChunk.interrupts!.map((i: any) => ({ interruptId: i.id, response: 'no' })),
          conversationId,
        );
        assert.ok(resumed.some((c: any) => c.type === 'done'), 'agent should complete after denial');
        // After denial, conversation history should show the tool was cancelled (not executed successfully)
        const { messages } = await api.cannedGetConversation(conversationId);
        const toolResult = messages.find((m: any) => m.role === 'tool-result');
        assert.ok(toolResult, 'should have tool-result message');
        const output = toolResult.metadata.toolOutput;
        assert.ok(JSON.stringify(output).includes('denied'), 'tool-result should contain denial message');
      });
    });

    // Direct browser→AgentCore WebSocket streaming. This is the whole point of moving off
    // Lambda: a turn can run far past the API-Gateway ~30s cap. wsAgent runs a `slowStream`
    // tool that sleeps 35s; the buffered RPC path (agentStream) would 504 at the gateway, but
    // the WS transport streams the turn to completion. Sandbox-only (needs a deployed runtime).
    describe('WebSocket long-running streaming (>35s)', { skip: !isSandbox || 'requires a deployed runtime' }, () => {
      test('a >35s turn streams to completion over the direct WebSocket', { timeout: 120_000 }, async () => {
        const api = getApi();

        // wsAgentGetStreamEndpoint requires a session (it calls requireAuth) and sources the
        // server-trusted userId from it — the runtime can't derive identity itself because its
        // JWT authorizer validates the token at the gateway, not in the container. Provision the
        // Cognito user server-side (the e2e runner's --conditions=browser can't construct the AWS
        // SDK client-side, and Cognito self-signup codes aren't retrievable in-process), then
        // sign in from here to establish the cookie session.
        const { username, password } = await api.wsAgentTestCreateUser();

        try {
          await api.authCSignIn(username, password);

          // Wire the shipped client transport exactly as an app would: the endpoint method
          // returns { wsUrl, token, userId }; the transport opens the socket (JWT via the
          // Sec-WebSocket-Protocol subprotocol) and yields chunks through useChat's seam.
          const streamChunks = createAgentCoreWsTransport(
            async ({ conversationId }) => await api.wsAgentGetStreamEndpoint(conversationId),
          );

          const conversationId = crypto.randomUUID();
          const start = Date.now();
          const chunks: string[] = [];
          for await (const chunk of streamChunks({ conversationId, message: 'Please run slowStream now' })) {
            chunks.push((chunk as any).type);
          }
          const elapsedMs = Date.now() - start;

          assert.ok(elapsedMs > 35_000, `turn should run past the 35s slow tool (took ${elapsedMs}ms)`);
          assert.ok(chunks.includes('tool-call'), 'should have called the slow tool');
          assert.ok(chunks.includes('tool-result'), 'slow tool should have returned a result');
          assert.ok(chunks.includes('done'), 'turn should complete with a done chunk');
          assert.ok(!chunks.includes('error'), `turn should not error, got chunks: ${JSON.stringify(chunks)}`);
        } finally {
          await api.authCSignOut();
          await api.wsAgentTestDeleteUser(username);
        }
      });

      // wsAgent declares a toolContextSchema, so a turn REQUIRES tool `context`. The browser-direct
      // transport carries none — before server-side context resolution this threw "Invalid tool
      // context". Now the container resolves `{ userId: sub }` from the verified claims, so a
      // context-scoped tool runs browser-direct. Completing without an error chunk proves it.
      test('a context-scoped tool runs browser-direct (server-resolved context)', { timeout: 60_000 }, async () => {
        const api = getApi();
        const { username, password } = await api.wsAgentTestCreateUser();
        try {
          await api.authCSignIn(username, password);
          const streamChunks = createAgentCoreWsTransport(
            async ({ conversationId }) => await api.wsAgentGetStreamEndpoint(conversationId),
          );
          const conversationId = crypto.randomUUID();
          const chunks: string[] = [];
          for await (const chunk of streamChunks({ conversationId, message: 'Please run whoami now' })) {
            chunks.push((chunk as any).type);
          }
          assert.ok(chunks.includes('tool-call'), 'should have called whoami');
          assert.ok(chunks.includes('tool-result'), 'whoami should have returned (context was valid)');
          assert.ok(chunks.includes('done'), 'turn should complete');
          assert.ok(!chunks.includes('error'), `no error expected, got: ${JSON.stringify(chunks)}`);
        } finally {
          await api.authCSignOut();
          await api.wsAgentTestDeleteUser(username);
        }
      });
    });
  });
}
