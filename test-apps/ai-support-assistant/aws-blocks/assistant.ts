// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A small, deterministic "agent runtime" that orchestrates AgentCore Memory and
 * AgentCore Gateway — the same shape AgentCore Runtime gives you, simulated
 * locally so the whole loop is testable offline:
 *
 *   user turn ─▶ remember (Memory.createEvent)
 *            ─▶ recall   (Memory.retrieveMemories: facts + preferences)
 *            ─▶ plan     (intent detection → Gateway.callTool)
 *            ─▶ respond  (compose reply from tool results + recalled memory)
 *            ─▶ remember (Memory.createEvent, ASSISTANT)
 *
 * In production the rule-based planner here is exactly where you'd drop in the
 * `Agent` block (an LLM) — the Memory/Gateway wiring is unchanged.
 */

// Structural subsets of the AgentCore blocks — keeps the runtime decoupled and
// trivially testable.
export interface MemoryLike {
  createEvent(input: {
    actorId: string;
    sessionId: string;
    role?: 'USER' | 'ASSISTANT';
    text: string;
  }): Promise<unknown>;
  retrieveMemories(input: {
    namespace: string;
    query: string;
    topK?: number;
  }): Promise<Array<{ content: string; score: number }>>;
}

export interface GatewayLike {
  callTool(name: string, args: Record<string, unknown>): Promise<{ tool: string; result: unknown }>;
}

export interface AssistantTurn {
  userId: string;
  sessionId: string;
  text: string;
}

export interface AssistantReply {
  reply: string;
  toolCalls: Array<{ tool: string; result: unknown }>;
  recalled: { facts: string[]; preferences: string[] };
}

export class SupportAssistant {
  constructor(
    private readonly memory: MemoryLike,
    private readonly gateway: GatewayLike,
  ) {}

  async handleMessage(turn: AssistantTurn): Promise<AssistantReply> {
    const { userId, sessionId, text } = turn;

    // 1. Remember the user's turn (short-term + long-term extraction).
    await this.memory.createEvent({ actorId: userId, sessionId, role: 'USER', text });

    // 2. Recall relevant long-term memory for this user.
    const factHits = await this.memory.retrieveMemories({
      namespace: `/facts/${userId}`,
      query: text,
      topK: 3,
    });
    const prefHits = await this.memory.retrieveMemories({
      namespace: `/preferences/${userId}`,
      query: text,
      topK: 2,
    });
    const facts = factHits.map((h) => h.content);
    const preferences = prefHits.map((h) => h.content);

    // 3. Plan: detect intent and call gateway tools.
    const toolCalls: Array<{ tool: string; result: unknown }> = [];
    const lower = text.toLowerCase();

    const orderId = matchOrderId(text);
    if (orderId && /\border\b/.test(lower)) {
      toolCalls.push(await this.gateway.callTool('get_order_status', { orderId }));
    }

    if (/\b(refund|cancel|broken|problem|issue|complaint|charged|charge|fraud)\b/.test(lower)) {
      toolCalls.push(await this.gateway.callTool('create_ticket', { userId, subject: text }));
    }

    if (/\b(shipping|returns?|hours|how|what|when)\b/.test(lower)) {
      toolCalls.push(await this.gateway.callTool('lookup_faq', { topic: text }));
    }

    // 4. Compose the reply.
    const reply = composeReply({ toolCalls, preferences, facts });

    // 5. Remember the assistant's turn.
    await this.memory.createEvent({ actorId: userId, sessionId, role: 'ASSISTANT', text: reply });

    return { reply, toolCalls, recalled: { facts, preferences } };
  }
}

function matchOrderId(text: string): string | null {
  const m = text.match(/#?(\d{3,})/);
  return m ? m[1] : null;
}

function composeReply(args: {
  toolCalls: Array<{ tool: string; result: unknown }>;
  preferences: string[];
  facts: string[];
}): string {
  const { toolCalls, preferences } = args;
  const parts: string[] = [];

  for (const call of toolCalls) {
    const r = call.result as Record<string, unknown>;
    if (call.tool === 'get_order_status') {
      parts.push(
        r.found
          ? `Your order is ${r.status} (ETA ${r.eta}).`
          : `I couldn't find that order — please double-check the number.`,
      );
    } else if (call.tool === 'create_ticket') {
      parts.push(`I've opened support ticket ${r.ticketId} and our team will follow up.`);
    } else if (call.tool === 'lookup_faq' && r.answer) {
      parts.push(String(r.answer));
    }
  }

  if (parts.length === 0) {
    parts.push("I'm here to help — could you share your order number or describe the issue?");
  }

  const concise = preferences.some((p) => /concise|short|brief/i.test(p));
  const reply = parts.join(' ');
  return concise ? reply : `${reply} Is there anything else I can help with?`;
}
