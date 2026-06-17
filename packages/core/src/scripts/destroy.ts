// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { trackCommand } from '../telemetry/trackCommand.js';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';
import { runSync } from './run-command.js';

export interface DestroyOptions {
  cdkAppPath: string;
  projectRoot: string;
}

export async function destroy(options: DestroyOptions) {
  return trackCommand('destroy', async () => {
    console.log('🗑️  Destroying production stack...');

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
      console.error('\n❌ Destroy failed.');
      throw error;
    }

    console.log('\n✅ Production stack destroyed!');
  });
}
