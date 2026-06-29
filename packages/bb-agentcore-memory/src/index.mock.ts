// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local (mock) implementation of the AgentCore Memory block.
 *
 * Simulates AgentCore Memory entirely in-process, persisting to
 * `<cwd>/.bb-data/<fullId>/memory.json`:
 *  - short-term events
 *  - long-term records produced by a deterministic local "extraction" pass
 *  - semantic retrieval approximated by lexical similarity
 *
 * Same public surface as `index.aws.ts`, so app code is identical in dev/prod.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Scope } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { BB_NAME, BB_VERSION } from './version.js';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import { memoryError, MemoryErrors } from './errors.js';
import { extractRecords, resolveNamespaces, scoreRelevance } from './extraction.js';
import type {
  AgentCoreMemoryOptions,
  CreateEventInput,
  ListEventsInput,
  ListSessionsInput,
  MemoryEvent,
  MemoryRecord,
  RetrieveInput,
} from './types.js';

export * from './types.js';
export { MemoryErrors } from './errors.js';

interface MemoryFile {
  events: MemoryEvent[];
  records: MemoryRecord[];
}

export class AgentCoreMemory extends Scope {
  private readonly options: AgentCoreMemoryOptions;
  private readonly filePath: string;
  private data: MemoryFile;

  constructor(scope: ScopeParent, id: string, options?: AgentCoreMemoryOptions) {
    super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
    this.options = options ?? {};
    this.filePath = join(getMockDataDir(this), 'memory.json');
    this.data = this.load();
  }

  /** Write a short-term event and (unless skipped) extract long-term records. */
  async createEvent(input: CreateEventInput): Promise<MemoryEvent> {
    if (!input.actorId) throw memoryError(MemoryErrors.InvalidInput, 'actorId is required');
    if (!input.sessionId) throw memoryError(MemoryErrors.InvalidInput, 'sessionId is required');
    if (typeof input.text !== 'string') throw memoryError(MemoryErrors.InvalidInput, 'text is required');

    const event: MemoryEvent = {
      eventId: randomUUID(),
      actorId: input.actorId,
      sessionId: input.sessionId,
      role: input.role ?? 'USER',
      text: input.text,
      timestamp: (input.timestamp ?? new Date()).toISOString(),
      metadata: input.metadata,
    };
    this.data.events.push(event);

    if (!input.skipExtraction) {
      for (const strategy of this.options.strategies ?? []) {
        // Count prior summaries in this strategy's exact (session-resolved) namespaces —
        // not a substring match, so session "s1" doesn't pick up "s11".
        const strategyNamespaces = new Set(resolveNamespaces(strategy, event));
        const priorSummaryCount = this.data.records.filter(
          (r) => r.strategyType === 'summary' && strategyNamespaces.has(r.namespace),
        ).length;
        const newRecords = extractRecords(strategy, event, priorSummaryCount, () => randomUUID());
        for (const rec of newRecords) {
          // Dedup identical facts/preferences in the same namespace; summaries always append.
          const dup =
            rec.strategyType !== 'summary' &&
            this.data.records.some(
              (r) => r.namespace === rec.namespace && r.content === rec.content,
            );
          if (!dup) this.data.records.push(rec);
        }
      }
    }

    this.persist();
    return event;
  }

  /** List short-term events for an actor + session, most recent first. */
  async listEvents(input: ListEventsInput): Promise<MemoryEvent[]> {
    const max = input.maxResults ?? 100;
    return this.data.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.actorId === input.actorId && event.sessionId === input.sessionId)
      // Most recent first; for equal timestamps fall back to insertion order (newest last
      // inserted), so same-millisecond events are still ordered deterministically.
      .sort((a, b) => b.event.timestamp.localeCompare(a.event.timestamp) || b.index - a.index)
      .slice(0, max)
      .map(({ event }) => event);
  }

  /** Semantic retrieval (approximated by lexical similarity) of long-term records. */
  async retrieveMemories(input: RetrieveInput): Promise<MemoryRecord[]> {
    if (!input.namespace) throw memoryError(MemoryErrors.InvalidInput, 'namespace is required');
    const topK = input.topK ?? 5;
    return this.data.records
      .filter((r) => r.namespace.startsWith(input.namespace))
      .map((r) => ({ ...r, score: scoreRelevance(input.query, r.content) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Distinct session ids seen for an actor. */
  async listSessions(input: ListSessionsInput): Promise<string[]> {
    const sessions = new Set<string>();
    for (const e of this.data.events) {
      if (e.actorId === input.actorId) sessions.add(e.sessionId);
    }
    return [...sessions];
  }

  private load(): MemoryFile {
    if (existsSync(this.filePath)) {
      try {
        return JSON.parse(readFileSync(this.filePath, 'utf8')) as MemoryFile;
      } catch {
        // Corrupt file — start fresh rather than crashing local dev.
      }
    }
    return { events: [], records: [] };
  }

  private persist(): void {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}
