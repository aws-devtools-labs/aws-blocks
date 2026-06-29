// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local simulation of AgentCore Memory's long-term extraction + semantic search.
 *
 * On AWS, extraction (events → memory records) and semantic retrieval are
 * performed by the managed service using LLMs and vector search. Locally we
 * approximate that behaviour deterministically with lightweight heuristics and
 * lexical (bag-of-words cosine) similarity — enough to develop and test agent
 * memory flows offline, with the *same* application code.
 */

import type { MemoryEvent, MemoryRecord, MemoryStrategy, MemoryStrategyType } from './types.js';

/** Expand `{actorId}` / `{sessionId}` placeholders in a namespace template. */
export function expandNamespace(
  template: string,
  vars: { actorId: string; sessionId: string },
): string {
  return template
    .replace(/\{actorId\}/g, vars.actorId)
    .replace(/\{sessionId\}/g, vars.sessionId);
}

/** Default namespace templates per strategy type (mirrors AgentCore conventions). */
export function defaultNamespaces(type: MemoryStrategyType): string[] {
  switch (type) {
    case 'semantic':
      return ['/facts/{actorId}'];
    case 'summary':
      return ['/summaries/{actorId}/{sessionId}'];
    case 'userPreference':
      return ['/preferences/{actorId}'];
  }
}

/** Resolve the concrete namespaces for a strategy + event. */
export function resolveNamespaces(
  strategy: MemoryStrategy,
  event: Pick<MemoryEvent, 'actorId' | 'sessionId'>,
): string[] {
  const templates = strategy.namespaces?.length ? strategy.namespaces : defaultNamespaces(strategy.type);
  return templates.map((t) => expandNamespace(t, event));
}

const PREFERENCE_CUES = [
  'i like', 'i love', 'i prefer', 'i enjoy', 'i hate', 'i dislike',
  'my favorite', 'my favourite', "i'd rather", 'i want', 'i always', 'i never',
];

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'as', 'it', 'this',
  'that', 'these', 'those', 'i', 'you', 'we', 'they', 'he', 'she', 'my', 'your',
  'me', 'do', 'does', 'did', 'so', 'if', 'then', 'than', 'too', 'very', 'can',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Extract long-term memory records contributed by a single event under one
 * strategy. Returns records keyed implicitly by `(namespace, content)` — the
 * caller is responsible for dedup/replace semantics.
 *
 * @param priorSummaryCount number of events already summarised for `summary`
 *   strategy (used to render a deterministic rolling summary).
 */
export function extractRecords(
  strategy: MemoryStrategy,
  event: MemoryEvent,
  priorSummaryCount: number,
  idFactory: () => string,
): MemoryRecord[] {
  // Only USER / ASSISTANT turns carry meaningful content for extraction.
  if (event.role !== 'USER' && event.role !== 'ASSISTANT') return [];
  const text = event.text.trim();
  if (!text) return [];

  const namespaces = resolveNamespaces(strategy, event);
  const out: MemoryRecord[] = [];

  for (const namespace of namespaces) {
    if (strategy.type === 'userPreference') {
      const lower = text.toLowerCase();
      if (event.role === 'USER' && PREFERENCE_CUES.some((c) => lower.includes(c))) {
        out.push(record(idFactory(), namespace, text, 'userPreference', event.timestamp));
      }
      continue;
    }

    if (strategy.type === 'semantic') {
      // Treat each declarative sentence of the turn as a candidate fact.
      // Questions are not facts — skip them (the managed service's LLM-based
      // extractor would do the same).
      for (const sentence of splitSentences(text)) {
        if (!isQuestion(sentence) && tokenize(sentence).length >= 2) {
          out.push(record(idFactory(), namespace, sentence, 'semantic', event.timestamp));
        }
      }
      continue;
    }

    if (strategy.type === 'summary') {
      const count = priorSummaryCount + 1;
      const content = `Session summary (${count} message${count === 1 ? '' : 's'}). Latest ${event.role.toLowerCase()}: ${truncate(text, 240)}`;
      out.push(record(idFactory(), namespace, content, 'summary', event.timestamp));
      continue;
    }
  }
  return out;
}

function record(
  id: string,
  namespace: string,
  content: string,
  strategyType: MemoryStrategyType,
  createdAt: string,
): MemoryRecord {
  return { memoryRecordId: id, namespace, content, score: 0, strategyType, createdAt };
}

const INTERROGATIVES =
  /^(what|which|who|whom|whose|when|where|why|how|is|are|am|was|were|do|does|did|can|could|should|would|will|may|might)\b/i;

/** Heuristic: a sentence is a question if it ends with '?' or opens interrogatively. */
function isQuestion(sentence: string): boolean {
  const s = sentence.trim();
  return s.endsWith('?') || INTERROGATIVES.test(s);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Lexical similarity between query and content, approximating semantic search.
 * Bag-of-words cosine similarity over content tokens, in [0, 1].
 */
export function scoreRelevance(query: string, content: string): number {
  const q = tokenize(query);
  const c = tokenize(content);
  if (q.length === 0 || c.length === 0) return 0;

  const qCounts = counts(q);
  const cCounts = counts(c);
  let dot = 0;
  for (const [term, qn] of qCounts) {
    const cn = cCounts.get(term);
    if (cn) dot += qn * cn;
  }
  const qMag = magnitude(qCounts);
  const cMag = magnitude(cCounts);
  if (qMag === 0 || cMag === 0) return 0;
  return dot / (qMag * cMag);
}

function counts(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function magnitude(c: Map<string, number>): number {
  let sum = 0;
  for (const n of c.values()) sum += n * n;
  return Math.sqrt(sum);
}
