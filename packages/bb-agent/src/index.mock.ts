// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertNotMockInDeployedEnv } from '@aws-blocks/core/bb-utils';

// Fail closed if this MOCK entry is loaded in a deployed environment (the
// artifact was bundled without the `aws-runtime` export condition). No-op
// locally. See assertNotMockInDeployedEnv.
assertNotMockInDeployedEnv('bb-agent');

export { Agent } from './agent.mock.js';
// Exported so api-extractor can resolve the (protected, @internal) dispatchTurn signature; the type
// itself is @internal — not part of the public API (customers use stream()/resume()).
export type { AgentTurnPayload } from './agent.js';
export { AgentErrors, InterruptError } from './errors.js';
export { BedrockModels, OllamaModels } from './models.js';
export type { AgentConfig, AgentResult, AgentStreamChunk, AgentStreamResult, ToolDefinition, AgentTool, ToolFactory, ToolsConfig, ToolHandlerArgs, DefaultToolContext, InterruptResponse, ToolCallRecord, ModelConfig, BedrockGuardrail, StreamOptions, Message, Conversation, JSONValue, TokenUsage } from './types.js';
