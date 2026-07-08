// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared, zero-runtime types for the AgentCore Memory block.
 *
 * The same public surface is implemented by every layer (mock / aws / cdk),
 * so application code compiles and runs identically in local dev and on AWS.
 *
 * Mirrors the Amazon Bedrock AgentCore Memory data model:
 *  - short-term memory  = immutable, timestamped `events` scoped by actor + session
 *  - long-term memory   = `memory records` extracted from events by strategies,
 *                         stored under hierarchical namespaces, retrieved by
 *                         semantic search.
 */

/** Conversational role of an event, matching AgentCore's `role` enum. */
export type MemoryRole = 'USER' | 'ASSISTANT' | 'TOOL' | 'OTHER';

/**
 * Long-term memory strategy types.
 * - `semantic`        — extract factual knowledge from the conversation.
 * - `summary`         — maintain a rolling summary per session.
 * - `userPreference`  — learn stable user preferences.
 */
export type MemoryStrategyType = 'semantic' | 'summary' | 'userPreference';

export interface MemoryStrategy {
  type: MemoryStrategyType;
  /** Human-readable strategy name (also used as the strategy id locally). */
  name: string;
  /**
   * Namespace templates. Supports `{actorId}` and `{sessionId}` placeholders.
   * When omitted, a sensible default per strategy type is used:
   *  - semantic        → `/facts/{actorId}`
   *  - summary         → `/summaries/{actorId}/{sessionId}`
   *  - userPreference  → `/preferences/{actorId}`
   */
  namespaces?: string[];
}

export interface AgentCoreMemoryOptions {
  /** Short-term event retention in days. Default 90. */
  eventExpiryDays?: number;
  /**
   * Long-term memory strategies. When empty, only short-term memory (events)
   * is available — `retrieveMemories` returns nothing.
   */
  strategies?: MemoryStrategy[];
  /** Whether the underlying memory resource is destroyed on stack deletion. Default 'destroy'. */
  removalPolicy?: 'destroy' | 'retain';
}

/** Input to {@link AgentCoreMemory.createEvent}. */
export interface CreateEventInput {
  /** Entity (user/agent) the event belongs to. Required. */
  actorId: string;
  /** Ordered conversation/session id. Required. */
  sessionId: string;
  /** Conversational role. Default 'USER'. */
  role?: MemoryRole;
  /** Message text (the conversational content). */
  text: string;
  /** Event time. Defaults to now. */
  timestamp?: Date;
  /** Up to 15 string key/value pairs attached to the event. */
  metadata?: Record<string, string>;
  /**
   * When true, the event is stored in short-term memory but excluded from
   * long-term extraction (AgentCore `extractionMode: "SKIP"`).
   */
  skipExtraction?: boolean;
}

/** A stored short-term memory event. */
export interface MemoryEvent {
  eventId: string;
  actorId: string;
  sessionId: string;
  role: MemoryRole;
  text: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  metadata?: Record<string, string>;
}

export interface ListEventsInput {
  actorId: string;
  sessionId: string;
  /** Max events to return (most recent first). Default 100. */
  maxResults?: number;
}

export interface ListSessionsInput {
  actorId: string;
}

/** Input to {@link AgentCoreMemory.retrieveMemories} (semantic long-term search). */
export interface RetrieveInput {
  /**
   * Namespace prefix to search within, after template expansion.
   * e.g. `/facts/user-123` or `/preferences/user-123`.
   */
  namespace: string;
  /** Natural-language search query. */
  query: string;
  /** Max records to return, ordered by relevance. Default 5. */
  topK?: number;
}

/** A long-term memory record returned by retrieval. */
export interface MemoryRecord {
  memoryRecordId: string;
  namespace: string;
  content: string;
  /** Relevance score in [0, 1]; higher is more relevant. */
  score: number;
  strategyType: MemoryStrategyType;
  /** ISO-8601 timestamp. */
  createdAt: string;
}
