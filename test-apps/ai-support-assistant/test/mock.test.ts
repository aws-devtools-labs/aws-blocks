// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end behaviour of the AI support assistant against the mock layers —
 * the full Memory + Gateway loop, offline. Demonstrates:
 *   - Gateway tool calls (order lookup, ticket creation, FAQ)
 *   - AgentCore Memory recall ACROSS sessions (facts + preferences)
 *   - AsyncJob background ticket enrichment
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Scope } from '@aws-blocks/core';
import { createAssistantSystem } from '../aws-blocks/system.js';

function newSystem() {
  return createAssistantSystem(new Scope(`assistant-${randomUUID()}`));
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, predicate: (v: T) => boolean, ms = 1500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v && predicate(v)) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

describe('SupportAssistant (mock)', () => {
  test('exposes its tools via the gateway (MCP tools/list)', async () => {
    const sys = newSystem();
    const tools = await sys.gateway.listTools();
    const bare = tools.map((t) => t.name.split('___').pop()).sort();
    assert.deepEqual(bare, ['create_ticket', 'get_order_status', 'lookup_faq']);
  });

  test('answers an order-status question by calling the gateway', async () => {
    const sys = newSystem();
    await sys.orders.put('1001', { orderId: '1001', status: 'shipped', eta: '2 days' });
    const res = await sys.assistant.handleMessage({
      userId: 'u1',
      sessionId: 's1',
      text: 'Where is my order #1001?',
    });
    assert.ok(res.toolCalls.some((c) => c.tool === 'get_order_status'));
    assert.match(res.reply, /shipped/);
  });

  test('opens a ticket and enriches its priority in the background', async () => {
    const sys = newSystem();
    const res = await sys.assistant.handleMessage({
      userId: 'u1',
      sessionId: 's1',
      text: 'My device is broken and I want a refund!',
    });
    const ticketCall = res.toolCalls.find((c) => c.tool === 'create_ticket');
    assert.ok(ticketCall, 'expected a ticket to be created');
    const ticketId = (ticketCall!.result as { ticketId: string }).ticketId;
    assert.match(res.reply, /opened support ticket/);

    // AsyncJob enrichment runs off the request path; poll for it.
    const ticket = await waitFor(
      () => sys.tickets.get(ticketId),
      (t) => t.priority !== 'pending',
    );
    assert.equal(ticket.priority, 'high'); // "broken"/"refund" → high
  });

  test('answers an FAQ via the gateway', async () => {
    const sys = newSystem();
    const res = await sys.assistant.handleMessage({
      userId: 'u1',
      sessionId: 's1',
      text: 'What are your shipping options?',
    });
    assert.ok(res.toolCalls.some((c) => c.tool === 'lookup_faq'));
    assert.match(res.reply, /3–5 business days/);
  });

  test('recalls FACTS learned in an earlier session', async () => {
    const sys = newSystem();
    // Session A — the user states a fact.
    await sys.assistant.handleMessage({
      userId: 'dana',
      sessionId: 'sessionA',
      text: 'For the record, I use Python as my main language.',
    });
    // Session B — a new session, same user; the fact should be recalled.
    const res = await sys.assistant.handleMessage({
      userId: 'dana',
      sessionId: 'sessionB',
      text: 'Which language do I use?',
    });
    assert.ok(
      res.recalled.facts.some((f) => /python/i.test(f)),
      `expected a recalled fact about Python, got ${JSON.stringify(res.recalled.facts)}`,
    );
  });

  test('recalls a PREFERENCE across sessions and adapts the reply', async () => {
    const sys = newSystem();
    // Session A — the user expresses a preference.
    await sys.assistant.handleMessage({
      userId: 'sam',
      sessionId: 'sessionA',
      text: 'I prefer concise answers please.',
    });
    // Session B — a query that recalls the concise preference.
    const res = await sys.assistant.handleMessage({
      userId: 'sam',
      sessionId: 'sessionB',
      text: 'Concise please — what are your hours?',
    });
    assert.ok(
      res.recalled.preferences.some((p) => /concise/i.test(p)),
      'expected the concise preference to be recalled from session A',
    );
    // Concise mode drops the "anything else?" trailer.
    assert.doesNotMatch(res.reply, /anything else/);
  });

  test('memory isolates users (no cross-user leakage)', async () => {
    const sys = newSystem();
    await sys.assistant.handleMessage({
      userId: 'alice',
      sessionId: 's1',
      text: 'I use Python as my main language.',
    });
    const res = await sys.assistant.handleMessage({
      userId: 'mallory',
      sessionId: 's1',
      text: 'Which language do I use?',
    });
    assert.equal(res.recalled.facts.length, 0, 'another user must not see alice’s facts');
  });
});
