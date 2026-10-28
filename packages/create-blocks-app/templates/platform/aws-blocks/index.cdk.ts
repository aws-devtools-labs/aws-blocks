import * as cdk from 'aws-cdk-lib';

import { BlocksStack, BlocksPresets } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getStackName } from '@aws-blocks/blocks/scripts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

// This app runs on a shared app platform: one AWS account, many apps, one
// pipeline. The platform's pipeline sets the app's id from its own registry —
// never take it from a value this repository chooses.
const appId = process.env.APP_ID;
if (!appId) {
  throw new Error(
    'APP_ID is not set. The platform pipeline sets it to this app\'s id (lowercase letters and digits). ' +
      'For a sandbox, export APP_ID=<your app id> first.',
  );
}

// Every name AWS Blocks derives starts with the stack name, and the platform's
// policies fence each app to its own `<id>-…` names, so the stack is named
// `<id>` (or `<id>-<sandbox>` for a sandbox).
const stackName = sandboxMode ? `${appId}-${getStackName({ sandbox: true, projectRoot })}` : appId;

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: {
    ...(sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production),
    // Tags every resource and role `app=<id>`, and fails synth if anything in
    // this app reaches outside it (see the README's "Platform rules").
    app: { id: appId, strict: true },
    // The platform's boundary policy, attached to every role this app creates.
    permissionsBoundary: process.env.APP_PERMISSIONS_BOUNDARY ?? 'apps-boundary',
  },
});
