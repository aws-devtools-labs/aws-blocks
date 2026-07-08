// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser stub. AgentCore Memory is server-only; the real callable surface
 * reaches the client through generated RPC, not this class.
 */

import { memoryError, MemoryErrors } from './errors.js';

export * from './types.js';
export { MemoryErrors } from './errors.js';

export class AgentCoreMemory {
  constructor(..._args: unknown[]) {
    throw memoryError(
      MemoryErrors.BrowserNotSupported,
      'AgentCoreMemory cannot be used in the browser. Call it from a backend ApiNamespace method.',
    );
  }
}
