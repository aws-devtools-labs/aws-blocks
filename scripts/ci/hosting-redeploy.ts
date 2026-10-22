// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Second-deploy check for a hosting e2e job on a non-CloudFront front door
// (HOSTING_FRONT_DOOR, e.g. `alb`). CI's sandbox is otherwise always a fresh
// create, so a door that only breaks on an UPDATE (the build cutover, the
// asset proxy's build prefix, listener rules) would pass. This redeploys the
// sandbox the e2e suite left running (BLOCKS_SANDBOX_KEEP=1) — a new build id
// — and requires the door to serve the new build:
// - `/.blocks-sandbox/config.json` names the new build id;
// - `/` serves the SPA shell, and its hashed script loads;
// - the API still answers same-origin.
//
// Usage: npx tsx scripts/ci/hosting-redeploy.ts <app-dir>
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (!process.argv[2]) {
  console.error('Usage: tsx scripts/ci/hosting-redeploy.ts <app-dir>');
  process.exit(1);
}
const appDir = resolve(process.argv[2]);

const hostingUrl = (): string => {
  const outputs = JSON.parse(readFileSync(join(appDir, '.blocks-sandbox', 'outputs.json'), 'utf-8')) as Record<
    string,
    Record<string, string>
  >;
  const stackOutputs = Object.values(outputs)[0] ?? {};
  const key = Object.keys(stackOutputs).find((k) => k.startsWith('HostingHostingUrl'));
  const raw = key ? stackOutputs[key] : undefined;
  if (!raw) throw new Error(`HostingHostingUrl* missing from outputs: ${JSON.stringify(stackOutputs)}`);
  return (raw.startsWith('http') ? raw : `https://${raw}`).replace(/\/$/, '');
};
const buildIdAt = async (url: string): Promise<string | undefined> => {
  const res = await fetch(`${url}/.blocks-sandbox/config.json?__redeploy=${Date.now()}`);
  if (res.status !== 200) return undefined;
  return ((await res.json()) as { __blocksBuildId?: string }).__blocksBuildId;
};

const before = await buildIdAt(hostingUrl());
process.chdir(appDir);
const { startSandbox } = await import('@aws-blocks/blocks/scripts');
await startSandbox({ backendPath: join(appDir, 'aws-blocks', 'index.cdk.ts'), deployOnly: true });
const url = hostingUrl();

let last = 'no response';
let ok = false;
for (let attempt = 1; attempt <= 20 && !ok; attempt++) {
  const buildId = await buildIdAt(url);
  const home = await fetch(`${url}/?__redeploy=${Date.now()}`);
  const html = await home.text();
  const script = html.match(/\/assets\/[^"']+\.js/)?.[0];
  const asset = script ? await fetch(`${url}${script}`) : undefined;
  const rpc = await fetch(`${url}/aws-blocks/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'api.getPublicStats', params: [] }),
  });
  ok = buildId !== undefined && buildId !== before && home.status === 200 && asset?.status === 200 && rpc.status === 200;
  last = `build ${before} → ${buildId}, / ${home.status}, ${script ?? 'no script'} ${asset?.status ?? '-'}, rpc ${rpc.status}`;
  if (!ok) await new Promise((r) => setTimeout(r, 6000));
}
if (!ok) throw new Error(`redeploy did not serve the new build: ${last}`);
console.log(`✅ redeploy served the new build (${last})`);
