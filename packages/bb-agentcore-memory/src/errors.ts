// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Stable error names thrown by the AgentCore Memory block. */
export const MemoryErrors = {
  InvalidInput: 'AgentCoreMemory.InvalidInput',
  BrowserNotSupported: 'AgentCoreMemory.BrowserNotSupported',
  NotConfigured: 'AgentCoreMemory.NotConfigured',
} as const;

export type MemoryErrorName = (typeof MemoryErrors)[keyof typeof MemoryErrors];

/** Construct an Error with a stable, namespaced `name`. */
export function memoryError(name: MemoryErrorName, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}
