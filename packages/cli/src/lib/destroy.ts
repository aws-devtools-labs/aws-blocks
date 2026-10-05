// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { trackCommand } from '@aws-blocks/core/runtime';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';
import { runSync } from './run-command.js';
import { info, error as logError } from '../logger.js';

export interface DestroyOptions {
  cdkAppPath: string;
  projectRoot: string;
}

export async function destroy(options: DestroyOptions) {
  return trackCommand('destroy', async () => {
    info('🗑️  Destroying production stack…');

    try {
      runSync(
        "npx",
        [
          "cdk", "destroy",
          "--force",
          "--context", `projectRoot=${options.projectRoot}`,
        ],
        {
          stdio: 'inherit',
          cwd: options.projectRoot,
          env: {
            ...process.env,
            NODE_OPTIONS: '--conditions=cdk',
            ...getCdkTelemetryEnv('production')
          }
        }
      );
    } catch (error) {
      logError('Destroy failed.');
      throw error;
    }

    info('\n✅ Production stack destroyed.');
  });
}
