// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime implementation of the AgentCore Memory block.
 *
 * Backed by the Amazon Bedrock AgentCore data plane
 * (`@aws-sdk/client-bedrock-agentcore`). The memory resource itself is
 * provisioned by the CDK layer, which injects its id via an env var.
 */

import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { BB_NAME, BB_VERSION } from './version.js';
import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListEventsCommand,
  ListSessionsCommand,
  RetrieveMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { memoryError, MemoryErrors } from './errors.js';
import { memoryEnvVar } from './naming.js';
import type {
  AgentCoreMemoryOptions,
  CreateEventInput,
  ListEventsInput,
  ListSessionsInput,
  MemoryEvent,
  MemoryRecord,
  MemoryRole,
  MemoryStrategyType,
  RetrieveInput,
} from './types.js';

export * from './types.js';
export { MemoryErrors } from './errors.js';

export class AgentCoreMemory extends Scope {
  private readonly client: BedrockAgentCoreClient;
  private readonly memoryId: string;

  constructor(scope: ScopeParent, id: string, _options?: AgentCoreMemoryOptions) {
    super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
    this.memoryId = process.env[memoryEnvVar(this.fullId)] ?? '';
    this.client = new BedrockAgentCoreClient({});
  }

  private requireMemoryId(): string {
    if (!this.memoryId) {
      throw memoryError(
        MemoryErrors.NotConfigured,
        `Memory id not found for "${this.fullId}". Was the CDK layer deployed?`,
      );
    }
    return this.memoryId;
  }

  async createEvent(input: CreateEventInput): Promise<MemoryEvent> {
    if (!input.actorId) throw memoryError(MemoryErrors.InvalidInput, 'actorId is required');
    if (!input.sessionId) throw memoryError(MemoryErrors.InvalidInput, 'sessionId is required');

    const role: MemoryRole = input.role ?? 'USER';
    const timestamp = input.timestamp ?? new Date();
    const res = await this.client.send(
      new CreateEventCommand({
        memoryId: this.requireMemoryId(),
        actorId: input.actorId,
        sessionId: input.sessionId,
        eventTimestamp: timestamp,
        payload: [{ conversational: { content: { text: input.text }, role } }],
        // NOTE: input.metadata is echoed in the return value but not yet persisted to
        // AgentCore (its MetadataValue union needs typed mapping). Mock-only for now —
        // see DESIGN.md "Mock parity gaps".
      }),
    );
    const eventId = res.event?.eventId ?? '';
    return {
      eventId,
      actorId: input.actorId,
      sessionId: input.sessionId,
      role,
      text: input.text,
      timestamp: timestamp.toISOString(),
      metadata: input.metadata,
    };
  }

  async listEvents(input: ListEventsInput): Promise<MemoryEvent[]> {
    try {
      const res = await this.client.send(
        new ListEventsCommand({
          memoryId: this.requireMemoryId(),
          actorId: input.actorId,
          sessionId: input.sessionId,
          maxResults: input.maxResults ?? 100,
          includePayloads: true,
        }),
      );
      return (res.events ?? []).map((e) => ({
        eventId: e.eventId ?? '',
        actorId: e.actorId ?? input.actorId,
        sessionId: e.sessionId ?? input.sessionId,
        role: extractRole(e.payload),
        text: extractText(e.payload),
        timestamp: e.eventTimestamp ? new Date(e.eventTimestamp).toISOString() : '',
      }));
    } catch (err) {
      if (isNotFound(err)) return []; // unknown actor/session ⇒ no events yet
      throw err;
    }
  }

  async retrieveMemories(input: RetrieveInput): Promise<MemoryRecord[]> {
    try {
      const res = await this.client.send(
        new RetrieveMemoryRecordsCommand({
          memoryId: this.requireMemoryId(),
          namespace: input.namespace,
          searchCriteria: { searchQuery: input.query, topK: input.topK ?? 5 },
          maxResults: input.topK ?? 5,
        }),
      );
      return (res.memoryRecordSummaries ?? []).map((r) => {
        const namespace = r.namespaces?.[0] ?? input.namespace;
        return {
          memoryRecordId: r.memoryRecordId ?? '',
          namespace,
          content: recordContentText(r.content),
          score: r.score ?? 0,
          strategyType: strategyTypeForNamespace(namespace),
          createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : '',
        };
      });
    } catch (err) {
      if (isNotFound(err)) return []; // namespace not populated yet ⇒ no records
      throw err;
    }
  }

  async listSessions(input: ListSessionsInput): Promise<string[]> {
    try {
      const res = await this.client.send(
        new ListSessionsCommand({ memoryId: this.requireMemoryId(), actorId: input.actorId }),
      );
      return (res.sessionSummaries ?? []).map((s) => s.sessionId ?? '').filter(Boolean);
    } catch (err) {
      if (isNotFound(err)) return []; // unknown actor ⇒ no sessions yet
      throw err;
    }
  }
}

/**
 * True for AgentCore "not found" responses. A read for an actor/session/namespace
 * that has no data yet returns ResourceNotFoundException; we treat that as empty
 * rather than an error (the mock layer naturally returns empty in the same case).
 */
function isNotFound(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { name?: string }).name === 'ResourceNotFoundException'
  );
}

/**
 * Infer the strategy type from a record's namespace, so the AWS layer reports the
 * same `strategyType` the mock assigns (which derives it from the strategy that
 * produced the record). Mirrors the default namespace conventions.
 */
function strategyTypeForNamespace(namespace: string): MemoryStrategyType {
  if (namespace.includes('/preferences/') || namespace.endsWith('/preferences')) return 'userPreference';
  if (namespace.includes('/summaries/') || namespace.endsWith('/summaries')) return 'summary';
  return 'semantic';
}

// --- payload shape helpers (defensive against SDK union types) ---

function extractText(payload: unknown): string {
  if (!Array.isArray(payload)) return '';
  for (const item of payload) {
    const text = item?.conversational?.content?.text;
    if (typeof text === 'string') return text;
  }
  return '';
}

function extractRole(payload: unknown): MemoryRole {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const role = item?.conversational?.role;
      if (role === 'USER' || role === 'ASSISTANT' || role === 'TOOL' || role === 'OTHER') {
        return role;
      }
    }
  }
  return 'OTHER';
}

function recordContentText(content: unknown): string {
  if (content && typeof content === 'object' && 'text' in content) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return typeof content === 'string' ? content : '';
}
