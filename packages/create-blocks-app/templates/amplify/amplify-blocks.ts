/**
 * Blocks integration for Amplify Gen 2.
 *
 * Wires Building Blocks into the Amplify backend via a nested stack.
 * Passes Cognito config so Blocks can verify bearer tokens.
 */
import { createBlocksBackend } from '../aws-blocks/index.cdk.js';
import { registerConfig } from '@aws-blocks/blocks/cdk';

export async function initBlocks(backend: any) {
  const blocksStack = backend.createStack('blocks');
  const sandboxMode = process.env.AMPLIFY_SANDBOX === 'true';
  const blocks = await createBlocksBackend(blocksStack, sandboxMode);

  // Pass Amplify's Cognito config to the Blocks Lambda (if auth is configured)
  if (backend.auth?.resources?.cfnResources) {
    const { cfnUserPool, cfnUserPoolClient } = backend.auth.resources.cfnResources;
    registerConfig(blocks, 'COGNITO_USER_POOL_ID', cfnUserPool.ref);
    registerConfig(blocks, 'COGNITO_CLIENT_ID', cfnUserPoolClient.ref);
  }

  // Surface Blocks API URL in amplify_outputs.json
  backend.addOutput({
    custom: {
      blocks_api_url: blocks.apiUrl,
    },
  });

  return blocks;
}
