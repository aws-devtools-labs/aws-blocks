// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Construct } from 'constructs';

/**
 * Infrastructure layer function signature.
 * Exported from `infra.ts` in a Building Block.
 */
export type MaterializeFn<TOptions = any> = (
  scope: Construct,
  name: string,
  options: TOptions
) => void | Record<string, any>;

/**
 * Building Block metadata discovered by CDK Blocks.
 */
export interface BuildingBlockMetadata {
  name: string;
  runtimePath?: string;    // index.ts
  infraPath?: string;       // infra.ts
  mockPath?: string;        // mock.ts
  clientHookPath?: string;  // client-hook.ts
}

/**
 * Client-side protocol extension hook.
 */
export interface ClientSideAPIHook {
  onResponse?(response: Response): Promise<void>;
  onRequest?(request: Request): Promise<void>;
}
