// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser stub. Identity is server-only — credentials must never reach the
 * browser. The callable surface reaches the client through generated RPC.
 */

import { identityError, IdentityErrors } from './errors.js';

export * from './types.js';
export { IdentityErrors } from './errors.js';

export class AgentCoreIdentity {
  constructor(..._args: unknown[]) {
    throw identityError(
      IdentityErrors.BrowserNotSupported,
      'AgentCoreIdentity cannot be used in the browser. Call it from a backend ApiNamespace method.',
    );
  }
}
