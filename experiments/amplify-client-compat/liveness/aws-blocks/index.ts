import { ApiNamespace, Scope, AuthCognito, KVStore } from '@aws-blocks/blocks';
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
	RekognitionClient,
	CreateFaceLivenessSessionCommand,
	GetFaceLivenessSessionResultsCommand,
} from '@aws-sdk/client-rekognition';
import {
	SCOPE_ID,
	VEND_ROLE_NAME,
	SESSION_OWNERSHIP_TTL_SECONDS,
	STREAMING_SESSION_POLICY,
	assertOwner,
	assertSessionId,
} from './session.js';

// Face Liveness-on-Blocks POC. The stock Amplify UI <FaceLivenessDetectorCore>
// streams the user's video to Rekognition from the browser. Everything else is
// server-side in Blocks: sessions are created and scored by this API, bound to
// the signed-in user (session cookie + requireAuth), and the browser only gets
// short-lived credentials that can do one thing: rekognition:StartFaceLivenessSession.
// No Identity Pool and no Cognito tokens in the browser.

const scope = new Scope(SCOPE_ID);

const auth = new AuthCognito(scope, 'auth', {
	signInWith: 'email' as const,
	selfSignUp: true,
	mfa: 'off' as const,
	removalPolicy: 'destroy' as const,
});
export const authApi = auth.createApi();

/** sessionId -> userSub of the creator. */
const owners = new KVStore<string>(scope, 'owners', { ttl: true, removalPolicy: 'destroy' as const });

const rekognition = new RekognitionClient({});
const sts = new STSClient({});
let accountId: string | undefined;
async function getAccountId(): Promise<string> {
	accountId ??= (await sts.send(new GetCallerIdentityCommand({}))).Account!;
	return accountId;
}

export const liveness = new ApiNamespace(scope, 'liveness', (context) => ({
	/** Create a Rekognition Face Liveness session owned by the caller. */
	async createSession() {
		const user = await auth.requireAuth(context);
		const out = await rekognition.send(new CreateFaceLivenessSessionCommand({}));
		const sessionId = out.SessionId!;
		await owners.put(sessionId, user.userSub, { ttlSeconds: SESSION_OWNERSHIP_TTL_SECONDS });
		return { sessionId, region: process.env.AWS_REGION ?? '' };
	},

	/** Credentials for <FaceLivenessDetectorCore>'s credentialProvider: streaming only. */
	async getStreamingCredentials(sessionId: string) {
		const user = await auth.requireAuth(context);
		assertSessionId(sessionId);
		assertOwner(await owners.get(sessionId), user.userSub, sessionId);
		const out = await sts.send(
			new AssumeRoleCommand({
				RoleArn: `arn:aws:iam::${await getAccountId()}:role/${VEND_ROLE_NAME}`,
				RoleSessionName: `lv-${user.userSub}`.slice(0, 64),
				DurationSeconds: 900,
				Policy: STREAMING_SESSION_POLICY,
			}),
		);
		const c = out.Credentials!;
		return {
			accessKeyId: c.AccessKeyId!,
			secretAccessKey: c.SecretAccessKey!,
			sessionToken: c.SessionToken!,
			expiration: c.Expiration!.toISOString(),
		};
	},

	/** Score the session. Only the creator may read it; images are not returned. */
	async getResults(sessionId: string) {
		const user = await auth.requireAuth(context);
		assertSessionId(sessionId);
		assertOwner(await owners.get(sessionId), user.userSub, sessionId);
		const r = await rekognition.send(new GetFaceLivenessSessionResultsCommand({ SessionId: sessionId }));
		return {
			sessionId,
			status: r.Status,
			confidence: r.Confidence ?? null,
			isLive: r.Status === 'SUCCEEDED' && (r.Confidence ?? 0) >= 80,
			hasReferenceImage: !!r.ReferenceImage,
			auditImageCount: r.AuditImages?.length ?? 0,
		};
	},
}));
