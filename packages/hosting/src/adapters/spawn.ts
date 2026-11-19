// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptions } from 'node:child_process';
import crossSpawn from 'cross-spawn';

export const spawn = {
  sync: (
    bin: string,
    args: readonly string[],
    options: SpawnSyncOptions,
  ): void => {
    const result = crossSpawn.sync(bin, args as string[], options);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `Command failed (exit code ${result.status}): ${bin} ${args.join(' ')}`,
      );
    }
  },
};
