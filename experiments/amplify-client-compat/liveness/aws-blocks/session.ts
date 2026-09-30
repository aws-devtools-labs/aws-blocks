// Shared by the app (index.ts), the CDK stack (index.cdk.ts) and the tests.
// Kept out of index.ts because a Blocks index.ts may only export ApiNamespaces.

export const SCOPE_ID = 'amplv-4d2e9';
/** Role the API assumes to mint streaming-only credentials; created in index.cdk.ts. */
export const VEND_ROLE_NAME = `${SCOPE_ID}-liveness-vend`;
/** Liveness sessions expire 3 minutes after creation; keep ownership a little longer. */
export const SESSION_OWNERSHIP_TTL_SECONDS = 10 * 60;

/**
 * Session policy for the browser's credentials. The browser only streams video
 * to an existing session; creating sessions and reading results stay on the
 * server.
 */
export const STREAMING_SESSION_POLICY = JSON.stringify({
	Version: '2012-10-17',
	Statement: [{ Effect: 'Allow', Action: 'rekognition:StartFaceLivenessSession', Resource: '*' }],
});

export class SessionDeniedError extends Error {
	override name = 'AccessDeniedException';
}

/** A session may only be used by the user who created it. */
export function assertOwner(owner: string | null, userSub: string, sessionId: string): void {
	if (owner === null) throw new SessionDeniedError(`unknown or expired liveness session ${sessionId}`);
	if (owner !== userSub) throw new SessionDeniedError(`liveness session ${sessionId} belongs to another user`);
}

/** Liveness session ids are UUIDs; refuse anything else before it reaches DynamoDB or Rekognition. */
export function assertSessionId(sessionId: unknown): asserts sessionId is string {
	if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
		throw new SessionDeniedError('malformed liveness session id');
	}
}
