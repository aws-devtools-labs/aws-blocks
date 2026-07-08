// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Advanced example backend — an AI support assistant.
 *
 * Showcases the two custom AgentCore blocks working together with first-party
 * blocks:
 *
 *   browser ──RPC──▶ api (ApiNamespace)
 *                       │
 *                       ▼
 *                 SupportAssistant  ("agent runtime" loop)
 *                  ├─▶ AgentCoreMemory 'memory'   per-user facts + preferences
 *                  └─▶ AgentCoreGateway 'tools'   MCP tools the agent can call
 *                        ├─ get_order_status ─▶ KVStore 'orders'
 *                        ├─ create_ticket    ─▶ KVStore 'tickets' + AsyncJob 'enrich'
 *                        └─ lookup_faq
 *
 * The rule-based planner in SupportAssistant is where the first-party `Agent`
 * (LLM) block drops in for production — the Memory/Gateway wiring is unchanged.
 */

import { ApiNamespace, Scope } from '@aws-blocks/blocks';
import { createAssistantSystem } from './system.js';

const scope = new Scope('support-assistant');
const { assistant, gateway, orders, tickets } = createAssistantSystem(scope);

export const api = new ApiNamespace(scope, 'api', () => ({
  /** Send a message to the assistant. */
  async chat(userId: string, sessionId: string, text: string) {
    return assistant.handleMessage({ userId, sessionId, text });
  },
  /** List the MCP tools the assistant exposes (AgentCore Gateway tools/list). */
  async tools() {
    return gateway.listTools();
  },
  /** Read a ticket (to observe async enrichment). */
  async getTicket(ticketId: string) {
    return tickets.get(ticketId);
  },
  /** Seed demo order data (kept out of module top-level so CDK synth is clean). */
  async seedDemoData() {
    await orders.put('1001', { orderId: '1001', status: 'shipped', eta: '2 days' });
    await orders.put('1002', { orderId: '1002', status: 'processing', eta: '5 days' });
    return { ok: true };
  },
}));
