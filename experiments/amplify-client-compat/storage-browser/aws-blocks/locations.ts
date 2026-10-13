// Shared by the app (index.ts), the CDK stack (index.cdk.ts) and the tests.
// Kept out of index.ts because a Blocks index.ts may only export ApiNamespaces.

/** Scope id; also the prefix of the bucket name, so it must be globally unique. */
export const SCOPE_ID = 'ampsb-7f3c1';
/** FileBucket id. The deployed bucket is named its fullId (`<stack>-<scope>-files`). */
export const BUCKET_ID = 'files';
/** Role the API assumes to mint scoped credentials; created in index.cdk.ts. */
export const VEND_ROLE_NAME = `${SCOPE_ID}-storage-vend`;
/** Dev origin of the web demo, allowed by the bucket's CORS rule. */
export const WEB_ORIGIN = 'http://localhost:5173';
/**
 * Origin of the hosted demo (Blocks Hosting on CloudFront). The distribution's
 * domain is only known after deploy, and referencing it from the bucket would
 * create a dependency cycle, so the CORS rule allows CloudFront origins by
 * wildcard. CORS is not an access control here: every S3 request still needs
 * credentials the Blocks API vends for one prefix.
 */
export const HOSTED_WEB_ORIGIN = 'https://*.cloudfront.net';
export const SHARED_PREFIX = 'public/';

export type Permission = 'get' | 'list' | 'write' | 'delete';
export interface Location {
	id: string;
	bucket: string;
	prefix: string;
	type: 'PREFIX';
	permissions: Permission[];
}

export function locationsFor(bucket: string, userSub: string): Location[] {
	return [
		{ id: 'mine', bucket, prefix: `private/${userSub}/`, type: 'PREFIX', permissions: ['get', 'list', 'write', 'delete'] },
		{ id: 'shared', bucket, prefix: SHARED_PREFIX, type: 'PREFIX', permissions: ['get', 'list'] },
	];
}

/**
 * Session policy for one granted location. STS intersects it with the vend
 * role's own policy, so the credentials can never exceed either.
 */
export function sessionPolicy(bucket: string, prefix: string, permissions: Permission[]): string {
	const objects = `arn:aws:s3:::${bucket}/${prefix}*`;
	const statements: object[] = [];
	if (permissions.includes('list')) {
		statements.push({
			Effect: 'Allow',
			Action: 's3:ListBucket',
			Resource: `arn:aws:s3:::${bucket}`,
			Condition: { StringLike: { 's3:prefix': [`${prefix}*`] } },
		});
	}
	if (permissions.includes('get')) statements.push({ Effect: 'Allow', Action: 's3:GetObject', Resource: objects });
	if (permissions.includes('write')) {
		statements.push({
			Effect: 'Allow',
			Action: ['s3:PutObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
			Resource: objects,
		});
	}
	if (permissions.includes('delete')) statements.push({ Effect: 'Allow', Action: 's3:DeleteObject', Resource: objects });
	return JSON.stringify({ Version: '2012-10-17', Statement: statements });
}

/**
 * Token-exchange spike: ONE session-wide policy for stock `aws-amplify/storage`
 * calls (`uploadData`, `list`, `getUrl`, `remove`). Amplify asks its
 * credentialsProvider for a single credential set per app, not per path, so
 * the policy is the union of every location the user may touch.
 */
export function sessionWidePolicy(bucket: string, userSub: string): string {
	const statements = locationsFor(bucket, userSub).flatMap((l) => JSON.parse(sessionPolicy(bucket, l.prefix, l.permissions)).Statement);
	return JSON.stringify({ Version: '2012-10-17', Statement: statements });
}

export class ScopeDeniedError extends Error {
	override name = 'AccessDeniedException';
}

/**
 * Resolve a StorageBrowser credentials request to one of the caller's
 * locations. The scope must sit inside the location's prefix and the
 * permissions must be a subset of what the location grants; anything else is
 * refused. Returns the literal key prefix the credentials will cover.
 */
export function authorizeScope(
	locations: Location[],
	scopeUri: string,
	permissions: Permission[],
): { location: Location; prefix: string } {
	const m = /^s3:\/\/([^/]+)\/(.*)$/.exec(scopeUri);
	if (!m) throw new ScopeDeniedError(`malformed scope ${scopeUri}`);
	const bucket = m[1]!;
	const path = m[2]!;
	// StorageBrowser asks for `<prefix>*`; strip the trailing wildcard so the
	// comparison is on literal key prefixes. A wildcard anywhere else would
	// widen the IAM resource, so it is refused.
	const prefix = path.endsWith('*') ? path.slice(0, -1) : path;
	if (/[*?]/.test(prefix)) throw new ScopeDeniedError(`wildcard in scope ${scopeUri}`);
	if (!Array.isArray(permissions) || permissions.length === 0) throw new ScopeDeniedError('no permissions requested');
	const location = locations.find((l) => l.bucket === bucket && prefix.startsWith(l.prefix));
	if (!location) throw new ScopeDeniedError(`scope ${scopeUri} is outside your locations`);
	const denied = permissions.filter((p) => !location.permissions.includes(p));
	if (denied.length) throw new ScopeDeniedError(`permission(s) ${denied.join(', ')} not granted on ${location.prefix}`);
	return { location, prefix };
}
