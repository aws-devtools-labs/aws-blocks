/**
 * Blocks integration for Amplify Gen 2.
 *
 * Wires Building Blocks into the Amplify backend via a nested stack, and hands
 * Amplify's Cognito user pool to the Blocks `Auth` block so its guards accept
 * the access tokens the Amplify frontend sends.
 */
import { createBlocksBackend } from '../aws-blocks/index.cdk.js';

export async function initBlocks(backend: any) {
  const blocksStack = backend.createStack('blocks');
  const sandboxMode = process.env.AMPLIFY_SANDBOX === 'true';

  // The Blocks backend module (aws-blocks/index.ts) is loaded while this CDK app
  // synthesizes. Hand it Amplify's pool and app-client ids first — CDK tokens,
  // resolved at deploy time. `Auth` forwards them to its Lambda through its own
  // config, so nothing is set on the Lambda's environment here.
  if (backend.auth?.resources?.cfnResources) {
    const { cfnUserPool, cfnUserPoolClient } = backend.auth.resources.cfnResources;
    process.env.AMPLIFY_USER_POOL_ID = cfnUserPool.ref;
    process.env.AMPLIFY_USER_POOL_CLIENT_ID = cfnUserPoolClient.ref;
  }

  const blocks = await createBlocksBackend(blocksStack, sandboxMode);

  // Surface Blocks API URL in amplify_outputs.json
  backend.addOutput({
    custom: {
      blocks_api_url: blocks.publicApiUrl,
    },
  });

  return blocks;
}
