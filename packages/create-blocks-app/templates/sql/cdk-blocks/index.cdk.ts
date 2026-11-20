import * as cdk from 'aws-cdk-lib';

import { BlocksStack, BlocksPresets } from 'aws-cdk-blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getStackName } from 'aws-cdk-blocks/scripts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

const stackName = getStackName({ sandbox: sandboxMode, projectRoot });
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production,
});
