// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Builds the assistant system (all blocks + the runtime loop) under a given
 * scope. Shared by the backend (`index.ts`) and the tests so both wire up the
 * exact same composition; tests pass a unique scope for isolation.
 */

import { Scope } from '@aws-blocks/core';
import { KVStore } from '@aws-blocks/bb-kv-store';
import { AsyncJob } from '@aws-blocks/bb-async-job';
import { AgentCoreMemory } from '@aws-blocks/bb-agentcore-memory';
import { AgentCoreGateway } from '@aws-blocks/bb-agentcore-gateway';
import { z } from 'zod';
import { SupportAssistant } from './assistant.js';
import { buildTools, classifyPriority, type OrderRecord, type TicketRecord } from './tools.js';

export interface AssistantSystem {
  memory: AgentCoreMemory;
  gateway: AgentCoreGateway;
  orders: KVStore<OrderRecord>;
  tickets: KVStore<TicketRecord>;
  enrich: AsyncJob<{ ticketId: string }>;
  assistant: SupportAssistant;
}

export function createAssistantSystem(scope: Scope): AssistantSystem {
  const memory = new AgentCoreMemory(scope, 'memory', {
    strategies: [
      { type: 'semantic', name: 'facts' },
      { type: 'userPreference', name: 'preferences' },
    ],
  });

  const orders = new KVStore<OrderRecord>(scope, 'orders');
  const tickets = new KVStore<TicketRecord>(scope, 'tickets');

  const enrich = new AsyncJob(scope, 'enrich', {
    schema: z.object({ ticketId: z.string() }),
    handler: async (payload: { ticketId: string }) => {
      const ticket = await tickets.get(payload.ticketId);
      if (!ticket) return;
      await tickets.put(payload.ticketId, { ...ticket, priority: classifyPriority(ticket.subject) });
    },
  });

  const gateway = new AgentCoreGateway(scope, 'tools', {
    tools: buildTools({
      orders,
      tickets,
      submitEnrichment: (ticketId) => enrich.submit({ ticketId }),
    }),
  });

  const assistant = new SupportAssistant(memory, gateway);

  return { memory, gateway, orders, tickets, enrich, assistant };
}
