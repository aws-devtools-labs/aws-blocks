// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { AgentCoreMemory } from './index.mock.js';
import type { AgentCoreMemoryOptions } from './types.js';

const ACTOR = 'user-123';

function newMemory(options?: AgentCoreMemoryOptions): AgentCoreMemory {
  // Unique id per instance so each test gets its own .bb-data dir.
  return new AgentCoreMemory({ id: 'testapp' }, `mem-${randomUUID()}`, options);
}

test('createEvent + listEvents (short-term memory)', async () => {
  const mem = newMemory();
  const session = 's1';
  await mem.createEvent({ actorId: ACTOR, sessionId: session, role: 'USER', text: 'Hello there' });
  await mem.createEvent({ actorId: ACTOR, sessionId: session, role: 'ASSISTANT', text: 'Hi! How can I help?' });

  const events = await mem.listEvents({ actorId: ACTOR, sessionId: session });
  assert.equal(events.length, 2);
  // Most recent first.
  assert.equal(events[0].role, 'ASSISTANT');
  assert.equal(events[1].text, 'Hello there');
  assert.ok(events[0].eventId);
});

test('createEvent requires actorId and sessionId', async () => {
  const mem = newMemory();
  await assert.rejects(
    () => mem.createEvent({ actorId: '', sessionId: 's', text: 'x' }),
    /actorId is required/,
  );
  await assert.rejects(
    () => mem.createEvent({ actorId: 'a', sessionId: '', text: 'x' }),
    /sessionId is required/,
  );
});

test('semantic strategy extracts facts that are retrievable', async () => {
  const mem = newMemory({ strategies: [{ type: 'semantic', name: 'facts' }] });
  await mem.createEvent({
    actorId: ACTOR,
    sessionId: 's1',
    role: 'USER',
    text: 'I work as a data engineer in Berlin. My main language is Python.',
  });

  const hits = await mem.retrieveMemories({ namespace: `/facts/${ACTOR}`, query: 'what programming language' });
  assert.ok(hits.length >= 1, 'expected at least one fact');
  assert.ok(hits[0].content.toLowerCase().includes('python'));
  assert.ok(hits[0].score > 0);
  assert.equal(hits[0].strategyType, 'semantic');
});

test('userPreference strategy only captures preference statements', async () => {
  const mem = newMemory({ strategies: [{ type: 'userPreference', name: 'prefs' }] });
  await mem.createEvent({ actorId: ACTOR, sessionId: 's1', role: 'USER', text: 'I like dark mode and concise answers.' });
  await mem.createEvent({ actorId: ACTOR, sessionId: 's1', role: 'USER', text: 'What time is it?' });

  const prefs = await mem.retrieveMemories({ namespace: `/preferences/${ACTOR}`, query: 'dark mode answers' });
  assert.equal(prefs.length, 1);
  assert.ok(prefs[0].content.includes('dark mode'));
});

test('summary strategy appends a rolling summary per session', async () => {
  const mem = newMemory({ strategies: [{ type: 'summary', name: 'sum' }] });
  await mem.createEvent({ actorId: ACTOR, sessionId: 's1', role: 'USER', text: 'Tell me about whales.' });
  await mem.createEvent({ actorId: ACTOR, sessionId: 's1', role: 'ASSISTANT', text: 'Whales are marine mammals.' });

  const sums = await mem.retrieveMemories({ namespace: `/summaries/${ACTOR}/s1`, query: 'whales summary' });
  assert.ok(sums.length >= 1);
  assert.ok(sums.some((s) => /summary/i.test(s.content)));
});

test('skipExtraction stores event but no long-term records', async () => {
  const mem = newMemory({ strategies: [{ type: 'semantic', name: 'facts' }] });
  await mem.createEvent({
    actorId: ACTOR,
    sessionId: 's1',
    role: 'USER',
    text: 'My secret token is abc123.',
    skipExtraction: true,
  });
  const events = await mem.listEvents({ actorId: ACTOR, sessionId: 's1' });
  assert.equal(events.length, 1);
  const hits = await mem.retrieveMemories({ namespace: `/facts/${ACTOR}`, query: 'secret token' });
  assert.equal(hits.length, 0);
});

test('identical facts are de-duplicated', async () => {
  const mem = newMemory({ strategies: [{ type: 'semantic', name: 'facts' }] });
  await mem.createEvent({ actorId: ACTOR, sessionId: 's1', role: 'USER', text: 'I love sushi.' });
  await mem.createEvent({ actorId: ACTOR, sessionId: 's2', role: 'USER', text: 'I love sushi.' });
  // Same fact text, same actor namespace → one record.
  const hits = await mem.retrieveMemories({ namespace: `/facts/${ACTOR}`, query: 'sushi' });
  assert.equal(hits.length, 1);
});

test('retrieval is scoped by namespace', async () => {
  const mem = newMemory({ strategies: [{ type: 'semantic', name: 'facts' }] });
  await mem.createEvent({ actorId: ACTOR, sessionId: 's1', role: 'USER', text: 'I drive a red car.' });
  const other = await mem.retrieveMemories({ namespace: '/facts/someone-else', query: 'car' });
  assert.equal(other.length, 0);
});

test('listSessions returns distinct sessions for an actor', async () => {
  const mem = newMemory();
  await mem.createEvent({ actorId: ACTOR, sessionId: 's1', text: 'a' });
  await mem.createEvent({ actorId: ACTOR, sessionId: 's2', text: 'b' });
  await mem.createEvent({ actorId: ACTOR, sessionId: 's1', text: 'c' });
  const sessions = await mem.listSessions({ actorId: ACTOR });
  assert.deepEqual([...sessions].sort(), ['s1', 's2']);
});

test('layer parity: mock/aws/cdk/browser expose the same public methods', async () => {
  const mock = await import('./index.mock.js');
  const aws = await import('./index.aws.js');
  const cdk = await import('./index.cdk.js');
  const browser = await import('./index.browser.js');

  const methods = (cls: any): string[] =>
    Object.getOwnPropertyNames(cls.prototype).filter((m) => m !== 'constructor');

  // Every layer must expose the full public surface (may also have private helpers).
  const expected = ['createEvent', 'listEvents', 'listSessions', 'retrieveMemories'];
  for (const layer of [mock.AgentCoreMemory, aws.AgentCoreMemory, cdk.AgentCoreMemory]) {
    const present = methods(layer);
    for (const m of expected) {
      assert.ok(present.includes(m), `expected method "${m}" on ${layer.name}`);
    }
  }
  // Browser is a throwing stub (server-only block).
  assert.equal(typeof browser.AgentCoreMemory, 'function');
});
