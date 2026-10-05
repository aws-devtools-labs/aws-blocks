// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from 'node:child_process';
import { trackCommand } from '@aws-blocks/core/runtime';
import { info, verbose } from '../logger.js';

export async function cleanup() {
  return trackCommand('cleanup', async () => {
    verbose('Cleaning up Blocks processes…');

    // Find and kill processes on common Blocks ports
    const ports = [3000, 3001, 3002, 3003];

    for (const port of ports) {
      try {
        const result = execSync(`lsof -ti:${port}`, { encoding: 'utf-8' }).trim();
        if (result) {
          const pids = result.split('\n');
          for (const pid of pids) {
            try {
              execSync(`kill ${pid}`);
              verbose(`Killed process ${pid} on port ${port}`);
            } catch {}
          }
        }
      } catch {
        // No process on this port
      }
    }

    info('✓ Cleanup complete');
  });
}
