// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { trackCommand } from '@aws-blocks/core/runtime';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';
import { runStreaming } from './deploy-stream.js';
import { createDeployStdout } from './deploy-progress.js';
import { filteredSink } from './stream-filter.js';
import { getLogLevel, info, verbose, error as logError } from '../logger.js';

export interface DestroyOptions {
  cdkAppPath: string;
  projectRoot: string;
}

export async function destroy(options: DestroyOptions) {
  return trackCommand('destroy', async () => {
    // The progress reporter owns the user-facing "Destroying" milestone.
    verbose('Destroying production stack…');

    const { sink: destroyStdout, finish: finishProgress } = createDeployStdout(
      process.stdout,
      getLogLevel(),
      { isTty: Boolean(process.stdout.isTTY), label: 'Destroying production stack', verb: 'destroy' },
    );
    try {
      await runStreaming(
        "npx",
        [
          "cdk", "destroy",
          "--force",
          "--context", `projectRoot=${options.projectRoot}`,
        ],
        {
          label: 'cdk destroy',
          cwd: options.projectRoot,
          // The reporter's live line is the "still working" signal; no heartbeat.
          heartbeatMs: getLogLevel() >= 2 ? undefined : 0,
          stdout: destroyStdout,
          stderr: filteredSink(process.stderr, getLogLevel()),
          env: {
            ...process.env,
            NODE_OPTIONS: '--conditions=cdk',
            ...getCdkTelemetryEnv('production')
          }
        }
      );
      finishProgress(true);
    } catch (error) {
      finishProgress(false);
      logError('Destroy failed.');
      throw error;
    }

    info('\n✅ Production stack destroyed.');
  });
}
