// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';
import { Hosting, BlocksStack, SandboxDisableDeletionProtection } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getSandboxId } from './scripts/sandbox-id.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

const suffix = process.env.BLOCKS_STACK_SUFFIX;

const stackName = sandboxMode
  ? `blocks-hosting-ssr-astro-${getSandboxId(projectRoot)}${suffix ? `-${suffix}` : ''}`
  : `blocks-hosting-ssr-astro-prod-${suffix || 'default'}`;

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
});

RemovalPolicies.of(blocksStack).destroy();
Mixins.of(blocksStack).apply(new SandboxDisableDeletionProtection());

// Astro static (multi-page) deploy. No `compute` block: a static Astro site
// has no SSR Lambda — every route is prerendered to its own index.html and
// served from S3. `api: blocksStack` still wires the single-origin
// /aws-blocks/* CloudFront proxy so client-side fetches reach the backend
// with no CORS.
new Hosting(blocksStack, 'Hosting', {
  root: join(__dirname, '..'),
  buildCommand: 'npx astro build',
  buildOutputDir: 'dist',
  framework: 'astro',
  api: blocksStack,
});

cdk.Tags.of(blocksStack).add('blocks:purpose', 'e2e-hosting-ssr-astro');
cdk.Tags.of(blocksStack).add('blocks:deploy-mode', sandboxMode ? 'sandbox' : 'production');
cdk.Tags.of(blocksStack).add('blocks:created-at', new Date().toISOString().split('T')[0]);
