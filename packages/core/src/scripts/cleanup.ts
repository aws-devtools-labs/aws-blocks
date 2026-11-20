#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from 'node:child_process';
import { trackCommand } from '../telemetry/trackCommand.js';

export async function cleanup() {
  return trackCommand('cleanup', async () => {
    console.log('🧹 Cleaning up AWS CDK Blocks processes...');

    // Find and kill processes on common CDK Blocks ports
    const ports = [3000, 3001, 3002, 3003];

    for (const port of ports) {
      try {
        const result = execSync(`lsof -ti:${port}`, { encoding: 'utf-8' }).trim();
        if (result) {
          const pids = result.split('\n');
          for (const pid of pids) {
            try {
              execSync(`kill ${pid}`);
              console.log(`✓ Killed process ${pid} on port ${port}`);
            } catch {}
          }
        }
      } catch {
        // No process on this port
      }
    }

    console.log('✓ Cleanup complete');
  });
}

cleanup().catch((error) => {
  console.error('Error during cleanup:', error);
  process.exit(1);
});
