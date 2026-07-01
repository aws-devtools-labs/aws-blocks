// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Stable error names thrown by the AgentCore Identity block. */
export const IdentityErrors = {
  ProviderNotFound: 'AgentCoreIdentity.ProviderNotFound',
  ProviderTypeMismatch: 'AgentCoreIdentity.ProviderTypeMismatch',
  MissingCredential: 'AgentCoreIdentity.MissingCredential',
  BrowserNotSupported: 'AgentCoreIdentity.BrowserNotSupported',
  NotConfigured: 'AgentCoreIdentity.NotConfigured',
} as const;

export type IdentityErrorName = (typeof IdentityErrors)[keyof typeof IdentityErrors];

export function identityError(name: IdentityErrorName, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}
