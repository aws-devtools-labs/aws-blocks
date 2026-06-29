// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Stable error names thrown by the AgentCore Gateway block. */
export const GatewayErrors = {
  InvalidInput: 'AgentCoreGateway.InvalidInput',
  ToolNotFound: 'AgentCoreGateway.ToolNotFound',
  BrowserNotSupported: 'AgentCoreGateway.BrowserNotSupported',
  NotConfigured: 'AgentCoreGateway.NotConfigured',
} as const;

export type GatewayErrorName = (typeof GatewayErrors)[keyof typeof GatewayErrors];

export function gatewayError(name: GatewayErrorName, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}
