import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { IUserPool, IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import type { IConstruct } from 'constructs';
import { BlocksStack, BlocksPresets, AuthCognito, Hosting } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SCOPE_ID, BUCKET_ID, VEND_ROLE_NAME } from './locations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = new cdk.App();
const stackName = app.node.tryGetContext('stackName') ?? 'amp-storage-browser';

export const blocksStack = await BlocksStack.create(app, stackName, {
	backendHandlerPath: join(__dirname, 'index.handler.ts'),
	backendCDKPath: join(__dirname, 'index.ts'),
	defaults: BlocksPresets.sandbox,
});

// The FileBucket's S3 bucket, found by its deterministic name (FileBucket keeps
// the construct private). Its name is also what the runtime reports.
const buckets = blocksStack.node
	.findAll()
	.filter((c): c is s3.CfnBucket => c instanceof s3.CfnBucket)
	.filter((b) => typeof b.bucketName === 'string' && b.bucketName.endsWith(`${SCOPE_ID}-${BUCKET_ID}`));
if (buckets.length !== 1) throw new Error(`expected exactly one ${SCOPE_ID}-${BUCKET_ID} bucket, found ${buckets.length}`);
const BUCKET = buckets[0]!.bucketName!;

// Credential-vending role. Only the Blocks backend role may assume it, and its
// own policy is the ceiling (the whole bucket); each AssumeRole call narrows it
// with a per-location session policy (see locations.ts sessionPolicy).
const vendRole = new iam.Role(blocksStack, 'StorageVendRole', {
	roleName: VEND_ROLE_NAME,
	assumedBy: new iam.ArnPrincipal(blocksStack.executionRole.roleArn),
	maxSessionDuration: cdk.Duration.hours(1),
	description: 'StorageBrowser POC: assumed by the Blocks API to mint per-user, per-location S3 credentials',
});
vendRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [`arn:aws:s3:::${BUCKET}`] }));
vendRole.addToPolicy(
	new iam.PolicyStatement({
		actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
		resources: [`arn:aws:s3:::${BUCKET}/*`],
	}),
);
blocksStack.executionRole.addToPrincipalPolicy(
	new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [vendRole.roleArn] }),
);

type CdkAuth = IConstruct & { userPool: IUserPool; userPoolClient: IUserPoolClient };
const auths = blocksStack.node.findAll().filter((c) => (c as unknown) instanceof AuthCognito) as CdkAuth[];
if (auths.length !== 1) throw new Error(`expected exactly one AuthCognito, found ${auths.length}`);
const auth = auths[0]!;
const stack = cdk.Stack.of(auth);
new cdk.CfnOutput(stack, 'AmplifyUserPoolId', { value: auth.userPool.userPoolId });
new cdk.CfnOutput(stack, 'AmplifyUserPoolClientId', { value: auth.userPoolClient.userPoolClientId });
new cdk.CfnOutput(stack, 'AmplifyRegion', { value: stack.region });
new cdk.CfnOutput(stack, 'StorageBucketName', { value: BUCKET });
new cdk.CfnOutput(stack, 'StorageVendRoleArn', { value: vendRole.roleArn });

// Demo site (opt-in: `-c hosting=true`): web/ on CloudFront, with the Blocks API
// proxied at /aws-blocks/api on the same domain. The CSP is the Hosting
// default plus the S3 endpoints <StorageBrowser> calls directly and blob: for
// in-memory downloads.
if (app.node.tryGetContext('hosting') === 'true') {
	new Hosting(blocksStack, 'Web', {
		root: join(__dirname, '..', 'web'),
		buildCommand: 'BLOCKS_HOSTED=1 node_modules/.bin/vite build',
		buildOutputDir: 'dist',
		framework: 'spa',
		api: blocksStack,
		contentSecurityPolicy:
			"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: wss:; media-src 'self' blob: https:; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'self'",
	});
}
