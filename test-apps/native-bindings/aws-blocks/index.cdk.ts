// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Deploy scaffolding for the native-bindings test backend. Used two ways:
//   1. Local developer sandbox (`npm run deploy:sandbox`, or `npm run sandbox`
//      for the watch loop) — the Dart Flutter example and OIDC relay testing
//      target the fixed-name `bb-test-native-bindings-dart` stack (the relay
//      needs a real HTTPS callback).
//   2. CI (the `*-e2e-sandbox` jobs in native-sdk-e2e.yml, four sandbox deploys
//      per run) — each runs `npm run deploy:sandbox`, then `npm run
//      sandbox:destroy`, against a per-run stack. They set BLOCKS_STACK_SUFFIX
//      to a unique value so concurrent runs get isolated stacks and never
//      collide with the developer sandbox.
// `npm run deploy` / `npm run destroy` are aliases for those two scripts. The
// app always synths with the `sandboxMode` CDK context (the App default below),
// which the app's stubIdp() OIDC providers require — so a direct `cdk synth`,
// `cdk deploy` or `cdk destroy` of this app passes that check too.
// Minimal variant of the comprehensive app's index.cdk.ts (no sandbox-id salt).

import * as cdk from 'aws-cdk-lib';
import { BlocksStack, BlocksPresets } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default the `sandboxMode` context to on. `npm run deploy:sandbox` (both uses
// above) already passes it; the default also covers a direct `cdk` command, so
// every path builds DistributedTable GSIs the way `npm run sandbox` does. Here
// that is the `todos` table and the Realtime connections table: the GSI custom resource
// recreates each table with all its indexes at once (about a minute) instead of
// adding them one at a time and waiting for each to backfill (about 17 minutes
// for `todos`). This stack is disposable (see `defaults` below); on the
// long-lived developer stack it also means a later index change drops and
// recreates the table.
//
// The recreate copies the items back (held only in the Lambda's memory:
// unprocessed batch writes are not retried, and a failure after the delete
// loses the ones not yet written) but not the settings CloudFormation applied
// when it created the table: TTL, the table tags and the encryption setting
// (the table falls back to the AWS owned key) are gone afterwards, while
// CloudFormation still records them. So the native suites run against a
// connections table with TTL off (`expiresAt` rows don't expire); no native
// test checks expiry or encryption, and that is accepted for these tests. The fast path re-applying them is tracked in
// https://github.com/aws-devtools-labs/aws-blocks/issues/985. The serial
// production GSI path, which keeps the table, is covered by the comprehensive
// app's production deploy. A direct
// `cdk synth/deploy --context sandboxMode=false` still overrides the default.
const app = new cdk.App({ context: { sandboxMode: 'true' } });

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
  // Disposable CI test stack: force the sandbox posture (DESTROY, no deletion
  // protection) so teardown works in every deploy mode. A real app would use
  // `sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`.
  defaults: BlocksPresets.sandbox,
});

// Tag for the scheduled stack janitor (cleanup-stacks.yml). It only deletes
// stacks tagged blocks:purpose=e2e-*, so without this a leaked per-run sandbox
// (failed `npm run sandbox:destroy`) matches the bb-test- prefix but is skipped and
// accumulates forever. Mirrors every other e2e test-app's index.cdk.ts.
cdk.Tags.of(blocksStack).add('blocks:purpose', 'e2e-native-bindings');
