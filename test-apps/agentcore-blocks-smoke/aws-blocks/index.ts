// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Smoke backend that instantiates all three custom AgentCore blocks so their
 * CDK layers emit real AWS::BedrockAgentCore::* resources for a deploy test.
 */

import { ApiNamespace, Scope } from '@aws-blocks/blocks';
import { AgentCoreMemory } from '@aws-blocks/bb-agentcore-memory';
import { AgentCoreGateway } from '@aws-blocks/bb-agentcore-gateway';
import { AgentCoreIdentity } from '@aws-blocks/bb-agentcore-identity';

const scope = new Scope('agentcore-smoke');

const memory = new AgentCoreMemory(scope, 'memory', {
  strategies: [{ type: 'semantic', name: 'facts' }],
});

const gateway = new AgentCoreGateway(scope, 'tools', {
  tools: {
    ping: {
      description: 'Returns pong.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => 'pong',
    },
  },
});

const identity = new AgentCoreIdentity(scope, 'identity', {
  providers: [{ type: 'apiKey', name: 'demo', apiKey: 'dev-only' }],
});

export const api = new ApiNamespace(scope, 'api', () => ({
  async tools() {
    return gateway.listTools();
  },
  async sessions(userId: string) {
    return memory.listSessions({ actorId: userId });
  },
  async endpoint() {
    return { gateway: gateway.getEndpoint() };
  },
  async whoami() {
    return identity.getWorkloadAccessToken();
  },
}));
