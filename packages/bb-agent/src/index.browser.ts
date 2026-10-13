// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AgentErrors, blocksAgentError } from './errors.js';

export { AgentErrors, InterruptError } from './errors.js';

export class Agent {
  constructor(..._args: any[]) {
    throw blocksAgentError(AgentErrors.BrowserNotSupported, 'Agent can only be instantiated on the server.');
  }
}
