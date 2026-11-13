/**
 * Blocks integration for Amplify Gen 2.
 *
 * Wires Building Blocks into the Amplify backend via a nested stack.
 * Passes Cognito config so Blocks can verify bearer tokens.
 */
import { registerConfig } from '@aws-blocks/blocks/cdk';
import type { Stack } from 'aws-cdk-lib';
import { createBlocksBackend } from '../aws-blocks/index.cdk.js';

/** The parts of Amplify Gen 2's `defineBackend(...)` result this file uses. */
interface AmplifyBackend {
  createStack(name: string): Stack;
  auth?: { resources?: { cfnResources?: { cfnUserPool: { ref: string }; cfnUserPoolClient: { ref: string } } } };
  addOutput(output: { custom: Record<string, unknown> }): void;
}

export async function initBlocks(backend: AmplifyBackend) {
  const blocksStack = backend.createStack('blocks');
  const sandboxMode = process.env.AMPLIFY_SANDBOX === 'true';
  const blocks = await createBlocksBackend(blocksStack, sandboxMode);

  // Pass Amplify's Cognito config to the Blocks runtime (if auth is configured).
  // Every Blocks compute loads it into process.env at cold start.
  if (backend.auth?.resources?.cfnResources) {
    const { cfnUserPool, cfnUserPoolClient } = backend.auth.resources.cfnResources;
    registerConfig(blocks, 'COGNITO_USER_POOL_ID', cfnUserPool.ref);
    registerConfig(blocks, 'COGNITO_CLIENT_ID', cfnUserPoolClient.ref);
    registerConfig(blocks, 'COGNITO_REGION', blocksStack.region);
  }

  // Surface Blocks API URL in amplify_outputs.json
  backend.addOutput({
    custom: {
      blocks_api_url: blocks.publicApiUrl,
    },
  });

  return blocks;
}
