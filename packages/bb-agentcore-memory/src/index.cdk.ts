// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK (infrastructure) implementation of the AgentCore Memory block.
 *
 * Provisions an Amazon Bedrock AgentCore Memory resource
 * (`AWS::BedrockAgentCore::Memory`), grants the Blocks Lambda the data-plane
 * permissions it needs, and injects the resulting memory id into the handler's
 * environment under a deterministic key (see naming.ts), which the AWS runtime
 * layer reads back.
 *
 * Runtime/data methods are synth guards: they only run in the aws-runtime build.
 */

import { CfnResource, RemovalPolicy } from 'aws-cdk-lib';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Scope, synthGuard } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import { BB_NAME, BB_VERSION } from './version.js';
import { defaultNamespaces } from './extraction.js';
import { memoryEnvVar, memoryResourceName } from './naming.js';
import type {
  AgentCoreMemoryOptions,
  CreateEventInput,
  ListEventsInput,
  ListSessionsInput,
  MemoryEvent,
  MemoryRecord,
  MemoryStrategy,
  RetrieveInput,
} from './types.js';

export * from './types.js';
export { MemoryErrors } from './errors.js';

export class AgentCoreMemory extends Scope {
  constructor(scope: ScopeParent, id: string, options?: AgentCoreMemoryOptions) {
    super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
    const strategies = options?.strategies ?? [];

    // A long-term memory resource needs an execution role AgentCore assumes to
    // run extraction (LLM-backed). Only created when strategies are configured.
    let executionRole: Role | undefined;
    if (strategies.length > 0) {
      executionRole = new Role(this, 'exec-role', {
        assumedBy: new ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      });
      executionRole.addToPolicy(
        new PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: ['arn:aws:bedrock:*::foundation-model/*'],
        }),
      );
    }

    const memory = new CfnResource(this, 'memory', {
      type: 'AWS::BedrockAgentCore::Memory',
      properties: {
        Name: memoryResourceName(this.fullId),
        EventExpiryDuration: options?.eventExpiryDays ?? 90,
        ...(executionRole ? { MemoryExecutionRoleArn: executionRole.roleArn } : {}),
        ...(strategies.length > 0
          ? { MemoryStrategies: strategies.map((s) => toCfnStrategy(s)) }
          : {}),
      },
    });
    if (options?.removalPolicy === 'retain') memory.applyRemovalPolicy(RemovalPolicy.RETAIN);

    // MemoryArn is the primary identifier; MemoryId is the data-plane handle.
    const memoryId = memory.getAtt('MemoryId').toString();
    const memoryArn = memory.getAtt('MemoryArn').toString();

    this.handler.addEnvironment(memoryEnvVar(this.fullId), memoryId);
    this.handler.addToRolePolicy(
      new PolicyStatement({
        actions: [
          'bedrock-agentcore:CreateEvent',
          'bedrock-agentcore:GetEvent',
          'bedrock-agentcore:ListEvents',
          'bedrock-agentcore:DeleteEvent',
          'bedrock-agentcore:ListSessions',
          'bedrock-agentcore:RetrieveMemoryRecords',
          'bedrock-agentcore:ListMemoryRecords',
          'bedrock-agentcore:GetMemoryRecord',
        ],
        resources: [memoryArn, `${memoryArn}/*`],
      }),
    );
  }

  // --- runtime methods: only valid in the aws-runtime build ---
  async createEvent(_input: CreateEventInput): Promise<MemoryEvent> {
    return synthGuard('AgentCoreMemory', 'createEvent');
  }
  async listEvents(_input: ListEventsInput): Promise<MemoryEvent[]> {
    return synthGuard('AgentCoreMemory', 'listEvents');
  }
  async retrieveMemories(_input: RetrieveInput): Promise<MemoryRecord[]> {
    return synthGuard('AgentCoreMemory', 'retrieveMemories');
  }
  async listSessions(_input: ListSessionsInput): Promise<string[]> {
    return synthGuard('AgentCoreMemory', 'listSessions');
  }
}

function toCfnStrategy(s: MemoryStrategy): Record<string, unknown> {
  const namespaces = s.namespaces?.length ? s.namespaces : defaultNamespaces(s.type);
  const body = { Name: s.name, Namespaces: namespaces };
  switch (s.type) {
    case 'semantic':
      return { SemanticMemoryStrategy: body };
    case 'summary':
      return { SummaryMemoryStrategy: body };
    case 'userPreference':
      return { UserPreferenceMemoryStrategy: body };
  }
}
