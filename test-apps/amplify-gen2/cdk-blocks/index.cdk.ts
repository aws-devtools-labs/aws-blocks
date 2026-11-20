/**
 * CDK Blocks CDK entry point for Amplify Gen 2 integration.
 *
 * This file is imported by amplify/blocks.ts to wire CDK Blocks into the Amplify backend.
 * It is NOT a standalone CDK app — Amplify's `ampx` CLI orchestrates synthesis.
 */
import { BlocksBackend, BlocksPresets } from 'aws-cdk-blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Stack } from 'aws-cdk-lib';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Create the CDK Blocks backend on the given CDK stack.
 * Called from amplify/blocks.ts with the stack Amplify provides.
 */
export async function createBlocksBackend(stack: Stack, sandboxMode: boolean) {
  // Propagate sandbox mode via CDK context: it sets the stack's deployment type
  // (the `blocks:deployment-type` tag and `getDeploymentType()` at runtime).
  // Removal policy and deletion protection (e.g. the `Database` cluster's) come
  // from `defaults` below.
  if (sandboxMode) {
    stack.node.setContext('sandboxMode', 'true');
  }

  const blocks = await BlocksBackend.create(stack, 'blocks', {
    backendHandlerPath: join(__dirname, 'index.handler.ts'),
    backendCDKPath: join(__dirname, 'index.ts'),
    defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production,
  });

  return blocks;
}
