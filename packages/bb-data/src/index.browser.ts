// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub — Database runs server-side only.
// This prevents Node.js/AWS SDK code from being bundled into client builds.
export class Database {
  constructor(..._args: any[]) {}
}

export { DatabaseErrors } from './errors.js';
export { fromExisting } from './from-existing.js';
