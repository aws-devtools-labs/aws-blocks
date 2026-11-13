// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Hosting, BlocksStack, BlocksPresets, secret, config, registerConfig } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getSandboxId } from './scripts/sandbox-id.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

const suffix = process.env.BLOCKS_STACK_SUFFIX;

const stackName = sandboxMode
  ? `blocks-hosting-ssr-${getSandboxId(projectRoot)}${suffix ? `-${suffix}` : ''}`
  : `blocks-hosting-ssr-prod-${suffix || 'default'}`;

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  // Disposable CI test stack: force the sandbox posture (DESTROY, no deletion
  // protection) so teardown works in every deploy mode. A real app would use
  // `sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`.
  defaults: BlocksPresets.sandbox,
});

// Hosting — Next.js SSR (CloudFront + Lambda)
new Hosting(blocksStack, 'Hosting', {
  root: join(__dirname, '..'),
  buildCommand: 'npx next build',
  framework: 'nextjs',
  api: blocksStack,
  buildCache: { enabled: true },
  // SSR cache-key credentials: include the app's session cookie
  // in the CloudFront SSR cache key so cacheable per-user responses are keyed
  // per session. Exercised over the wire by the
  // /cache-isolation route + test/e2e.test.ts "SSR cache isolation" suite.
  // (No app-wide ssrDefaultTtl: only routes that opt in via `s-maxage` cache,
  // keeping the other e2e routes uncached.)
  cacheKeyCookies: ['bb_session'],
  // HOSTING_COMPUTE_TYPE=web-function runs the same suite against AWS Lambda
  // Web Functions (OpenNext then builds a node-wrapper HTTP server).
  compute:
    process.env.HOSTING_COMPUTE_TYPE === 'web-function'
      ? { type: 'web-function', timeout: cdk.Duration.seconds(30) }
      : { memorySize: 1024, timeout: cdk.Duration.seconds(30) },
  // E2E: secret() → Secrets Manager, config() → SSM Parameter Store. The values
  // are written out of band by the CLI (see test/e2e.test.ts) and read at runtime
  // via getSecret/getConfig in /api/probe/secret.
  environment: {
    DEMO_SECRET: secret('DEMO_SECRET'),
    DEMO_CONFIG: config('DEMO_CONFIG'),
  },
});

// Sandbox e2e only — see "Sandbox e2e test support" in `index.ts`. The flag
// is read here at synth and registered as config (`registerConfig`, which
// every compute loads into `process.env` before the backend module is
// imported), so the deployed backend builds the same `testSupport` namespace
// that synth did. The run's test-support secret travels the same way: the
// e2e `globalSetup` (or the CI workflow) sets `BLOCKS_TEST_SUPPORT_SECRET`
// before synth, and the deployed backend reads it from config.
if (process.env.BLOCKS_TEST_ENV === 'sandbox') {
  registerConfig(blocksStack, 'BLOCKS_TEST_ENV', 'sandbox');
  // `index.ts` already refused to load without it, so it is set here.
  registerConfig(blocksStack, 'BLOCKS_TEST_SUPPORT_SECRET', process.env.BLOCKS_TEST_SUPPORT_SECRET);
}

cdk.Tags.of(blocksStack).add('blocks:purpose', 'e2e-hosting-ssr');
cdk.Tags.of(blocksStack).add('blocks:deploy-mode', sandboxMode ? 'sandbox' : 'production');
cdk.Tags.of(blocksStack).add('blocks:created-at', new Date().toISOString().split('T')[0]);
