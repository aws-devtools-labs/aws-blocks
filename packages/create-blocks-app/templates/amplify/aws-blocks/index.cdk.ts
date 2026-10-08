/**
 * Blocks CDK entry point for Amplify Gen 2 integration.
 *
 * This file is imported by amplify/blocks.ts to wire Blocks into the Amplify backend.
 * It is NOT a standalone CDK app — Amplify's `ampx` CLI orchestrates synthesis.
 */
import { BlocksBackend, BlocksPresets } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Stack } from 'aws-cdk-lib';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Create the Blocks backend on the given CDK stack.
 * Called from amplify/blocks.ts with the stack Amplify provides.
 */
export async function createBlocksBackend(stack: Stack, sandboxMode: boolean) {
  // Propagate sandbox mode via CDK context so Building Blocks (e.g. DistributedDatabase)
  // can detect it and disable deletion protection / set DESTROY removal policy.
  if (sandboxMode) {
    stack.node.setContext('sandboxMode', 'true');
  }

  // Amplify synthesizes via `ampx` and has no cdk.json, so set the bb-data
  // storage-encryption opt-in flag here instead — mirroring the
  // `@aws-blocks/bb-data:encryptStorageByDefault` entry in the create-blocks-app
  // cdk.json templates, so a new Amplify project encrypts Database storage by
  // default. Set unconditionally (not only in sandbox) so production deploys get it too.
  stack.node.setContext('@aws-blocks/bb-data:encryptStorageByDefault', true);

  const blocks = await BlocksBackend.create(stack, 'blocks', {
    backendHandlerPath: join(__dirname, 'index.handler.ts'),
    backendCDKPath: join(__dirname, 'index.ts'),
    defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production,
  });

  return blocks;
}
