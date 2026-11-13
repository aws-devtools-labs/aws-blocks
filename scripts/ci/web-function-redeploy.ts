// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Second-deploy check for `compute.type: 'web-function'` hosting e2e jobs.
//
// Sandbox deploys use CloudFormation Express Mode, which can't update a Lambda
// Web Function endpoint. That only breaks the SECOND sandbox deploy, and CI's
// fresh creates never see it. This redeploys the sandbox the e2e suite left
// running (BLOCKS_SANDBOX_KEEP=1) with a CODE change: it rewrites the app's
// deploy-marker module, so the bundle is re-copied, a new revision is created
// and the endpoint is re-pointed. It then requires the new code to be the one
// serving, from a Web Function:
// - the app's deploy-marker route returns the new marker;
// - the response carries `lambda-web-request-id`.
//
// Usage: npx tsx scripts/ci/web-function-redeploy.ts <app-dir>
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/** Per-app deploy-marker module + the route that returns it. */
const MARKERS: Record<string, { file: string; route: string }> = {
  'hosting-ssr-sveltekit': { file: 'src/lib/deploy-marker.ts', route: '/api/deploy-marker' },
  'hosting-ssr-nuxt': { file: 'server/deploy-marker.ts', route: '/api/deploy-marker' },
  'hosting-ssr': { file: 'src/deploy-marker.ts', route: '/api/probe/deploy-marker' },
};

if (!process.argv[2]) {
  console.error('Usage: tsx scripts/ci/web-function-redeploy.ts <app-dir>');
  process.exit(1);
}
const appDir = resolve(process.argv[2]);
const marker = MARKERS[basename(appDir)];
if (!marker) throw new Error(`No deploy-marker module registered for ${basename(appDir)} in ${import.meta.url}`);

const markerFile = join(appDir, marker.file);
const original = readFileSync(markerFile, 'utf-8');
const value = `redeploy-${Date.now()}`;
writeFileSync(markerFile, original.replace(/DEPLOY_MARKER = '[^']*'/, `DEPLOY_MARKER = '${value}'`));

try {
  process.chdir(appDir);
  const { startSandbox } = await import('@aws-blocks/blocks/scripts');
  await startSandbox({ backendPath: join(appDir, 'aws-blocks', 'index.cdk.ts'), deployOnly: true });

  const outputs = JSON.parse(readFileSync(join(appDir, '.blocks-sandbox', 'outputs.json'), 'utf-8')) as Record<
    string,
    Record<string, string>
  >;
  const stackOutputs = Object.values(outputs)[0] ?? {};
  const urlKey = Object.keys(stackOutputs).find((k) => k.startsWith('HostingHostingUrl'));
  const rawUrl = urlKey ? stackOutputs[urlKey] : undefined;
  if (!rawUrl) throw new Error(`HostingHostingUrl* missing from outputs: ${JSON.stringify(stackOutputs)}`);
  const url = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;

  // Retry briefly while the endpoint re-points to the new revision.
  let last = 'no response';
  let served = false;
  for (let attempt = 1; attempt <= 15 && !served; attempt++) {
    const res = await fetch(`${url}${marker.route}?__redeploy=${Date.now()}`);
    const body = (await res.text()).trim();
    const requestId = res.headers.get('lambda-web-request-id');
    served = res.status === 200 && body === value && requestId !== null;
    last = `status ${res.status}, body ${JSON.stringify(body.slice(0, 80))}, lambda-web-request-id ${requestId ?? 'missing'}`;
    if (!served) await new Promise((r) => setTimeout(r, 6000));
  }
  if (!served) throw new Error(`redeploy did not serve the new code from a Web Function: ${last}`);
  console.log(`✅ redeploy served the new code from a Web Function (${marker.route} → ${value}; ${last})`);
} finally {
  writeFileSync(markerFile, original);
}
