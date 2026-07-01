// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The support assistant's tools. These become AgentCore Gateway MCP tools, so
 * an agent (in-app or external) can call them. Handlers are backed by KVStores
 * and an AsyncJob — ordinary blocks that run locally and on AWS.
 */

import type { KVStore } from '@aws-blocks/bb-kv-store';
import type { ToolsConfig } from '@aws-blocks/bb-agentcore-gateway';

export interface OrderRecord {
  orderId: string;
  status: 'processing' | 'shipped' | 'delivered' | 'cancelled';
  eta: string;
}

export interface TicketRecord {
  ticketId: string;
  userId: string;
  subject: string;
  status: 'open' | 'closed';
  priority: 'pending' | 'normal' | 'high';
}

/** Pure classifier — the work an AsyncJob does to enrich a new ticket. */
export function classifyPriority(subject: string): 'normal' | 'high' {
  return /\b(urgent|asap|broken|refund|charged|charge|fraud|down|outage)\b/i.test(subject)
    ? 'high'
    : 'normal';
}

const FAQ: Record<string, string> = {
  shipping: 'Standard shipping takes 3–5 business days; express is 1–2.',
  returns: 'You can return any item within 30 days for a full refund.',
  hours: 'Support is available 24/7 via chat and 9–5 ET by phone.',
};

export interface ToolDeps {
  orders: KVStore<OrderRecord>;
  tickets: KVStore<TicketRecord>;
  /** Submit a ticket id for background priority enrichment. */
  submitEnrichment: (ticketId: string) => Promise<unknown>;
  idFactory?: () => string;
}

export function buildTools(deps: ToolDeps): ToolsConfig {
  const newId = deps.idFactory ?? (() => `tkt_${Math.random().toString(36).slice(2, 10)}`);

  return {
    get_order_status: {
      description: 'Look up the status and ETA of an order by its id.',
      inputSchema: {
        type: 'object',
        properties: { orderId: { type: 'string' } },
        required: ['orderId'],
      },
      handler: async (args) => {
        const order = await deps.orders.get(String(args.orderId));
        if (!order) return { found: false };
        return { found: true, status: order.status, eta: order.eta };
      },
    },

    create_ticket: {
      description: 'Open a support ticket for the user. Returns the ticket id.',
      inputSchema: {
        type: 'object',
        properties: { userId: { type: 'string' }, subject: { type: 'string' } },
        required: ['userId', 'subject'],
      },
      handler: async (args) => {
        const ticket: TicketRecord = {
          ticketId: newId(),
          userId: String(args.userId),
          subject: String(args.subject),
          status: 'open',
          priority: 'pending',
        };
        await deps.tickets.put(ticket.ticketId, ticket);
        // Background enrichment (priority classification) — fire and forget.
        await deps.submitEnrichment(ticket.ticketId);
        return { ticketId: ticket.ticketId, status: ticket.status };
      },
    },

    lookup_faq: {
      description: 'Answer a frequently-asked question by topic (shipping, returns, hours).',
      inputSchema: {
        type: 'object',
        properties: { topic: { type: 'string' } },
        required: ['topic'],
      },
      handler: async (args) => {
        const topic = String(args.topic).toLowerCase();
        const key = Object.keys(FAQ).find((k) => topic.includes(k));
        return key ? { answer: FAQ[key] } : { answer: null };
      },
    },
  };
}
