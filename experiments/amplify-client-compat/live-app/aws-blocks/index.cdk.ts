import * as cdk from 'aws-cdk-lib';
import type { IUserPool, IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import type { IConstruct } from 'constructs';
import { BlocksStack, BlocksPresets, AuthCognito } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = new cdk.App();
const stackName = app.node.tryGetContext('stackName') ?? 'amp-live-signin';

export const blocksStack = await BlocksStack.create(app, stackName, {
	backendHandlerPath: join(__dirname, 'index.handler.ts'),
	backendCDKPath: join(__dirname, 'index.ts'),
	defaults: BlocksPresets.sandbox,
});

// Surface the pool facts emitAmplifyOutputs needs. AuthCognito keeps
// userPool / userPoolClient public, so no escape hatch is needed. (Cast: tsc
// resolves the package's non-cdk types; synth runs with `-C cdk`.)
type CdkAuth = IConstruct & { userPool: IUserPool; userPoolClient: IUserPoolClient };
const auths = blocksStack.node.findAll().filter((c) => (c as unknown) instanceof AuthCognito) as CdkAuth[];
if (auths.length !== 1) throw new Error(`expected exactly one AuthCognito, found ${auths.length}`);
const auth = auths[0]!;
const stack = cdk.Stack.of(auth);
new cdk.CfnOutput(stack, 'AmplifyUserPoolId', { value: auth.userPool.userPoolId });
new cdk.CfnOutput(stack, 'AmplifyUserPoolClientId', { value: auth.userPoolClient.userPoolClientId });
new cdk.CfnOutput(stack, 'AmplifyRegion', { value: stack.region });
