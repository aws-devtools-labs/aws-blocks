import * as cdk from 'aws-cdk-lib';

import { Hosting, HostingPresets, BlocksStack, BlocksPresets } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getStackName } from '@aws-blocks/blocks/scripts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
// `npm run sandbox:preview` also sets previewMode: a sandbox with hosting in preview shape.
const previewMode = app.node.tryGetContext('previewMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

const stackName = getStackName({ sandbox: sandboxMode, projectRoot });
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production,
});

// Add Next.js SSR hosting when deploying, and to a preview sandbox in preview
// shape (served by API Gateway, no CloudFront). A plain sandbox is backend-only.
if (!sandboxMode || previewMode) {
  new Hosting(blocksStack, 'Hosting', {
    ...(previewMode ? HostingPresets.preview : HostingPresets.production),
    root: join(__dirname, '..'),
    buildCommand: 'npm run build',
    framework: 'nextjs',
    api: blocksStack,
    compute: {
      memorySize: 1024,
      timeout: 30,
    },
  });
}
