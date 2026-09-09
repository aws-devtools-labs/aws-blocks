// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { trackCommand } from '../telemetry/trackCommand.js';

export interface ConsoleOptions {
  stackId?: string;
  outputsFile?: string;
}

function resolveRegion(): string {
  const fromEnv = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (fromEnv) return fromEnv;
  try {
    const fromConfig = execFileSync('aws', ['configure', 'get', 'region'], { encoding: 'utf-8' }).trim();
    if (fromConfig) return fromConfig;
  } catch {
    // aws CLI not configured — fall through to default.
  }
  return 'us-east-1';
}

/** Launch the URL in the default browser. Best-effort: no opener (headless/CI) is not a failure. */
function openInBrowser(url: string): void {
  const opener =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'cmd' :
    'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    execFileSync(opener, args, { stdio: 'ignore' });
  } catch {
    // Headless environment (CI, remote shell) — the URL is already printed above.
    console.log('(Could not launch a browser automatically — open the URL above manually.)');
  }
}

export async function openConsole(options: ConsoleOptions) {
  return trackCommand('console', async () => {
    let stackName: string;

    if (options.stackId) {
      stackName = options.stackId;
    } else if (options.outputsFile) {
      const outputs = JSON.parse(readFileSync(options.outputsFile, 'utf-8'));
      stackName = Object.keys(outputs)[0];
    } else {
      throw new Error('Must provide either stackId or outputsFile');
    }

    const region = resolveRegion();
    const stackUrl = `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks?filteringText=${encodeURIComponent(stackName)}`;

    console.log('Opening AWS Console...');
    console.log(stackUrl);

    openInBrowser(stackUrl);
  });
}
