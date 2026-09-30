import { ApiNamespace, Scope, AuthCognito, FileBucket, getSdkIdentifiers } from '@aws-blocks/blocks';
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { SCOPE_ID, BUCKET_ID, VEND_ROLE_NAME, WEB_ORIGIN, HOSTED_WEB_ORIGIN, locationsFor, sessionPolicy, authorizeScope, type Permission } from './locations.js';

// StorageBrowser-on-Blocks POC. The stock Amplify UI <StorageBrowser> talks to
// S3 directly from the browser, but it never sees a Cognito token or an
// Identity Pool: it asks this API for (1) the locations the signed-in user may
// browse and (2) short-lived AWS credentials scoped to one location. Blocks
// keeps authentication on the server (session cookie + requireAuth) and
// enforces authorization by minting STS credentials whose session policy only
// covers that location. This is option (b) of decision 2.

const scope = new Scope(SCOPE_ID);

const auth = new AuthCognito(scope, 'auth', {
	signInWith: 'email' as const,
	selfSignUp: false, // hosted demo: admin-created users only
	mfa: 'off' as const,
	removalPolicy: 'destroy' as const,
});
export const authApi = auth.createApi();

// Browser uploads need
// PUT/POST from the demo origin, and multipart uploads (> 5 MB) need ETag exposed.
const files = new FileBucket(scope, BUCKET_ID, {
	removalPolicy: 'destroy' as const,
	versioned: false,
	corsRules: [
		{
			allowedOrigins: [WEB_ORIGIN, HOSTED_WEB_ORIGIN],
			allowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
			allowedHeaders: ['*'],
			exposedHeaders: ['ETag', 'x-amz-checksum-crc32', 'x-amz-request-id'],
			maxAge: 3000,
		},
	],
});

const sts = new STSClient({});
let accountId: string | undefined;
async function getAccountId(): Promise<string> {
	accountId ??= (await sts.send(new GetCallerIdentityCommand({}))).Account!;
	return accountId;
}

export const storage = new ApiNamespace(scope, 'storage', (context) => ({
	/** StorageBrowser `listLocations`: the signed-in user's browsable locations. */
	async listLocations() {
		const user = await auth.requireAuth(context);
		return { accountId: await getAccountId(), region: process.env.AWS_REGION ?? '', items: locationsFor(getSdkIdentifiers(files).bucketName, user.userSub) };
	},

	/** StorageBrowser `getLocationCredentials`: STS credentials for one location. */
	async getLocationCredentials(input: { scope: string; permissions: Permission[] }) {
		const user = await auth.requireAuth(context);
		const { location, prefix } = authorizeScope(locationsFor(getSdkIdentifiers(files).bucketName, user.userSub), input.scope, input.permissions);
		const out = await sts.send(
			new AssumeRoleCommand({
				RoleArn: `arn:aws:iam::${await getAccountId()}:role/${VEND_ROLE_NAME}`,
				RoleSessionName: `sb-${user.userSub}`.slice(0, 64),
				DurationSeconds: 900,
				Policy: sessionPolicy(location.bucket, prefix, input.permissions),
			}),
		);
		const c = out.Credentials!;
		return {
			scope: input.scope,
			permissions: input.permissions,
			credentials: {
				accessKeyId: c.AccessKeyId!,
				secretAccessKey: c.SecretAccessKey!,
				sessionToken: c.SessionToken!,
				expiration: c.Expiration!.toISOString(),
			},
		};
	},
}));
