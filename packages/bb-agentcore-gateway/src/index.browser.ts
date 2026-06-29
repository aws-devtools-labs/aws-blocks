// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser stub. AgentCore Gateway tools run on the backend; the real callable
 * surface reaches the client through generated RPC, not this class.
 */

import { gatewayError, GatewayErrors } from './errors.js';

export * from './types.js';
export { GatewayErrors } from './errors.js';

export class AgentCoreGateway {
  constructor(..._args: unknown[]) {
    throw gatewayError(
      GatewayErrors.BrowserNotSupported,
      'AgentCoreGateway cannot be used in the browser. Call it from a backend ApiNamespace method.',
    );
  }
}
