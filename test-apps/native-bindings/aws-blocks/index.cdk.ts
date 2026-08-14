// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Deploy scaffolding for the native-bindings test backend. Used two ways:
//   1. Local developer sandbox (`npm run deploy`) — the Dart Flutter example
//      and OIDC relay testing target the fixed-name `bb-test-native-bindings-dart`
//      stack (the relay needs a real HTTPS callback).
//   2. CI (native-sdk-e2e.yml `dart-e2e-sandbox` job) — deploys then tears down a
//      per-run stack. It sets BLOCKS_STACK_SUFFIX to a unique value so concurrent
//      runs get isolated stacks and never collide with the developer sandbox.
// Minimal variant of the comprehensive app's index.cdk.ts (no sandbox-id salt).

import * as cdk from 'aws-cdk-lib';
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';
import { BlocksStack, SandboxDisableDeletionProtection } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

// BLOCKS_STACK_NAME wins if set. Otherwise: the fixed developer-sandbox name when
// no suffix is present, or a compact suffixed name in CI (BLOCKS_STACK_SUFFIX is
// unique per run). The compact base keeps the derived S3 bucket name
// (`<stackName>-native-bindings-files`) within S3's 63-character limit — the
// verbose dev name plus a suffix would overflow it.
const suffix = process.env.BLOCKS_STACK_SUFFIX;
const stackName =
  process.env.BLOCKS_STACK_NAME ||
  (suffix ? `bb-test-nb-${suffix}` : 'bb-test-native-bindings-dart');

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
});

// Tag for the scheduled stack janitor (cleanup-stacks.yml). It only deletes
// stacks tagged blocks:purpose=e2e-*, so without this a leaked per-run sandbox
// (failed `npm run destroy`) matches the bb-test- prefix but is skipped and
// accumulates forever. Mirrors every other e2e test-app's index.cdk.ts.
cdk.Tags.of(blocksStack).add('blocks:purpose', 'e2e-native-bindings');

// E2E stacks must be fully deletable so the CI teardown (`npm run destroy`)
// can't leave a stuck DELETE_FAILED stack or deletion-protected resources behind.
RemovalPolicies.of(blocksStack).destroy();
Mixins.of(blocksStack).apply(new SandboxDisableDeletionProtection());
