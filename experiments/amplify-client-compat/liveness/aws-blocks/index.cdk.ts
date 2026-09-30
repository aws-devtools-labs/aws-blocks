import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { IUserPool, IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import type { IConstruct } from 'constructs';
import { BlocksStack, BlocksPresets, AuthCognito } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VEND_ROLE_NAME } from './session.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = new cdk.App();
const stackName = app.node.tryGetContext('stackName') ?? 'amp-liveness';

export const blocksStack = await BlocksStack.create(app, stackName, {
	backendHandlerPath: join(__dirname, 'index.handler.ts'),
	backendCDKPath: join(__dirname, 'index.ts'),
	defaults: BlocksPresets.sandbox,
});

// The Blocks backend creates and scores sessions (Blocks has no Rekognition
// block, so the grant is added here).
blocksStack.executionRole.addToPrincipalPolicy(
	new iam.PolicyStatement({
		actions: ['rekognition:CreateFaceLivenessSession', 'rekognition:GetFaceLivenessSessionResults'],
		resources: ['*'],
	}),
);

// Credential-vending role for the browser: streaming only, assumable only by
// the Blocks backend role.
const vendRole = new iam.Role(blocksStack, 'LivenessVendRole', {
	roleName: VEND_ROLE_NAME,
	assumedBy: new iam.ArnPrincipal(blocksStack.executionRole.roleArn),
	maxSessionDuration: cdk.Duration.hours(1),
	description: 'Liveness POC: assumed by the Blocks API to mint streaming-only credentials for the browser',
});
vendRole.addToPolicy(new iam.PolicyStatement({ actions: ['rekognition:StartFaceLivenessSession'], resources: ['*'] }));
blocksStack.executionRole.addToPrincipalPolicy(
	new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [vendRole.roleArn] }),
);

type CdkAuth = IConstruct & { userPool: IUserPool; userPoolClient: IUserPoolClient };
const auths = blocksStack.node.findAll().filter((c) => (c as unknown) instanceof AuthCognito) as CdkAuth[];
if (auths.length !== 1) throw new Error(`expected exactly one AuthCognito, found ${auths.length}`);
const auth = auths[0]!;
const stack = cdk.Stack.of(auth);
new cdk.CfnOutput(stack, 'AmplifyUserPoolId', { value: auth.userPool.userPoolId });
new cdk.CfnOutput(stack, 'AmplifyRegion', { value: stack.region });
new cdk.CfnOutput(stack, 'LivenessVendRoleArn', { value: vendRole.roleArn });
