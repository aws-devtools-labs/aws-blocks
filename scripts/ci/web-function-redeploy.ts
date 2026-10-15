// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Second-deploy check for `compute.type: 'web-function'` hosting e2e jobs.
//
// Sandbox deploys run CloudFormation in Express Mode (rollback disabled), which
// rejects REPLACEMENT updates. Every Lambda Web Function revision property is
// create-only, so a construct that updates its revision in place fails on the
// SECOND sandbox deploy only — CI's fresh creates never see it. This redeploys
// the sandbox the e2e suite left running (BLOCKS_SANDBOX_KEEP=1) with a changed
// env var (forcing a new revision), then checks the site still serves.
//
// Usage: npx tsx scripts/ci/web-function-redeploy.ts <app-dir>
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const appDir = resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  console.error('Usage: tsx scripts/ci/web-function-redeploy.ts <app-dir>');
  process.exit(1);
}
process.chdir(appDir);
// The app reads HOSTING_DEPLOY_MARKER into its environment: a new value means a
// new revision, exactly what an unchanged-but-rebuilt bundle also produces.
process.env.HOSTING_DEPLOY_MARKER = `redeploy-${Date.now()}`;

const { startSandbox } = await import('@aws-blocks/blocks/scripts');
await startSandbox({ backendPath: join(appDir, 'aws-blocks', 'index.cdk.ts'), deployOnly: true });

const outputs = JSON.parse(readFileSync(join(appDir, '.blocks-sandbox', 'outputs.json'), 'utf-8')) as Record<
  string,
  Record<string, string>
>;
const stackOutputs = Object.values(outputs)[0] ?? {};
const urlKey = Object.keys(stackOutputs).find((k) => k.startsWith('HostingHostingUrl'));
const url = urlKey ? stackOutputs[urlKey] : undefined;
if (!url) throw new Error(`HostingHostingUrl* missing from outputs: ${JSON.stringify(stackOutputs)}`);

// The new revision serves: retry briefly while the endpoint re-points.
let status = 0;
for (let attempt = 1; attempt <= 10; attempt++) {
  const res = await fetch(`${url.startsWith('http') ? url : `https://${url}`}/?__redeploy=${Date.now()}`);
  status = res.status;
  if (status === 200 && res.headers.get('lambda-web-request-id')) break;
  await new Promise((r) => setTimeout(r, 6000));
}
if (status !== 200) throw new Error(`site returned ${status} after redeploy`);
console.log(`✅ redeploy with a new Web Function revision succeeded; ${url} serves 200`);
