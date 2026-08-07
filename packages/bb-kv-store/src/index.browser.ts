// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub - KVStore runs server-side only
export class KVStore {
  constructor(...args: any[]) {}
  toAgentTools(..._args: any[]): never {
    throw new Error('KVStore.toAgentTools() is not available in the browser.');
  }
}
export { KVStoreErrors } from './errors.js';
