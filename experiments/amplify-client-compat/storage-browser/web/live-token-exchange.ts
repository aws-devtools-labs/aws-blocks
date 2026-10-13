/**
 * Token-exchange spike (candidate 4): stock `aws-amplify/storage` against a
 * Blocks backend with NO Identity Pool and NO Cognito sign-in in the client.
 *
 * The client signs in through Blocks (HttpOnly session cookie). Amplify is then
 * configured with custom Auth providers that exchange that cookie for what
 * Amplify needs:
 *   - credentialsProvider -> session.getAwsCredentials (15-min STS, identityId = sub)
 *   - tokenProvider       -> session.getTokens (variant B only; ID/access JWTs)
 * and the app calls the stock Storage API unchanged (`uploadData`, `list`,
 * `getUrl`, `downloadData`, `remove`), including path callbacks on identityId.
 *
 *   usage: live-token-exchange.ts <cdk outputs.json>
 *
 * Needs admin credentials for the sandbox account (creates/deletes 2 users).
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
// `Amplify`, `fetchAuthSession` and `decodeJWT` come from `@aws-amplify/core`
// rather than `aws-amplify`: in this install `aws-amplify@6.17.0` pins a nested
// core@6.16.3 while `@aws-amplify/storage` resolves the top-level core@6.19.2
// pulled in by `@aws-amplify/ui-react-storage`, and configuring the wrong
// singleton makes Storage report NoBucket. Same functions, same instance as Storage.
import { Amplify, decodeJWT, fetchAuthSession } from '@aws-amplify/core';
import { uploadData, list, getUrl, downloadData, remove } from 'aws-amplify/storage';
import type { CredentialsAndIdentityIdProvider, TokenProvider } from '@aws-amplify/core';
import {
	CognitoIdentityProviderClient,
	AdminCreateUserCommand,
	AdminSetUserPasswordCommand,
	AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const outputsPath = process.argv[2];
if (!outputsPath) throw new Error('usage: live-token-exchange.ts <cdk outputs.json>');
const out = Object.values(JSON.parse(readFileSync(outputsPath, 'utf-8')) as Record<string, Record<string, string>>)[0]!;
const apiUrl = out.ApiUrl!;
const region = out.AmplifyRegion!;
const poolId = out.AmplifyUserPoolId!;

const results: Array<[string, 'PASS' | 'FAIL' | 'INFO', string]> = [];
let failed = false;
const check = (name: string, ok: boolean, detail: string) => {
	results.push([name, ok ? 'PASS' : 'FAIL', detail]);
	if (!ok) failed = true;
};
const info = (name: string, detail: string) => results.push([name, 'INFO', detail]);
const errText = (e: unknown) => `${(e as Error).name}: ${(e as Error).message}`;

// ---- Blocks JSON-RPC (in a browser this is the generated client + the cookie jar)
let rpcId = 0;
let cookie = '';
async function rpc(method: string, params: unknown[] = []): Promise<any> {
	const res = await fetch(apiUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
		body: JSON.stringify({ jsonrpc: '2.0', method, params, id: ++rpcId }),
	});
	const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
	const set = res.headers.getSetCookie().map((c) => c.split(';')[0]!);
	if (set.length) cookie = set.filter((c) => !/=$/.test(c)).join('; ');
	if (body.error) throw Object.assign(new Error(body.error.message), { name: `BlocksRpc${body.error.code}`, code: body.error.code });
	return body.result;
}
const signIn = (username: string, password: string) => rpc('authApi.setAuthState', [{ action: 'signIn', username, password }]);
const signOut = () => rpc('authApi.setAuthState', [{ action: 'signOut' }]);

// ---- The integration surface a Blocks package would ship -------------------
let credentialCalls = 0;
let cached: { credentials: any; identityId: string } | undefined;
const credentialsProvider: CredentialsAndIdentityIdProvider = {
	async getCredentialsAndIdentityId({ forceRefresh }) {
		// Cache until 1 min before expiry, like Amplify's own Identity Pool provider.
		if (!forceRefresh && cached && cached.credentials.expiration.getTime() - Date.now() > 60_000) return cached;
		credentialCalls++;
		const r = await rpc('session.getAwsCredentials');
		cached = { identityId: r.identityId, credentials: { ...r.credentials, expiration: new Date(r.credentials.expiration) } };
		return cached;
	},
	clearCredentialsAndIdentityId() {
		cached = undefined;
	},
};
const tokenProvider: TokenProvider = {
	async getTokens(opts) {
		const t = await rpc('session.getTokens', [{ forceRefresh: !!opts?.forceRefresh }]).catch(() => null);
		return t ? { idToken: decodeJWT(t.idToken), accessToken: decodeJWT(t.accessToken) } : null;
	},
};
const nullTokenProvider: TokenProvider = { getTokens: async () => null };

function configure(variant: 'credentials-only' | 'with-tokens', bucket: string) {
	Amplify.configure(
		{ Storage: { S3: { bucket, region } } },
		{ Auth: { credentialsProvider, tokenProvider: variant === 'with-tokens' ? tokenProvider : nullTokenProvider } },
	);
}

// ---- Test users --------------------------------------------------------------
const idp = new CognitoIdentityProviderClient({ region });
const mkUser = () => ({ email: `amp-tx-${randomBytes(4).toString('hex')}@example.com`, password: `Aa1!${randomBytes(12).toString('hex')}` });
const userA = mkUser();
const userB = mkUser();
async function createUser(u: { email: string; password: string }) {
	await idp.send(new AdminCreateUserCommand({
		UserPoolId: poolId, Username: u.email, MessageAction: 'SUPPRESS',
		UserAttributes: [{ Name: 'email', Value: u.email }, { Name: 'email_verified', Value: 'true' }],
	}));
	await idp.send(new AdminSetUserPasswordCommand({ UserPoolId: poolId, Username: u.email, Password: u.password, Permanent: true }));
}

try {
	await createUser(userA);
	await createUser(userB);

	// B signs in to learn B's sub (the cross-user target), then signs out.
	await signIn(userB.email, userB.password);
	const subB: string = (await rpc('session.getAwsCredentials')).identityId;
	const { bucket } = await rpc('session.getStorageConfig');
	await signOut();
	cookie = '';

	// 0. Signed out: the exchange refuses, so stock Storage has no credentials.
	configure('credentials-only', bucket);
	try {
		await uploadData({ path: 'public/anon.txt', data: 'x' }).result;
		check('signed out: uploadData has no credentials', false, 'unexpectedly uploaded');
	} catch (e) {
		check('signed out: uploadData has no credentials', /401|NotAuthenticated|SessionExpired|NoCredentials/i.test(errText(e)), errText(e));
	}

	// ---------------- Variant A: credentials only, no JWTs in the client -------
	await signIn(userA.email, userA.password);
	check('Blocks sign-in sets a session cookie (no Cognito tokens in client)', !!cookie, cookie.replace(/=.*?(;|$)/g, '=…$1'));
	credentialsProvider.clearCredentialsAndIdentityId();
	configure('credentials-only', bucket);

	const s = await fetchAuthSession();
	check('fetchAuthSession: identityId = Cognito sub, credentials present', !!s.identityId && !!s.credentials?.accessKeyId, `identityId=${s.identityId}`);
	check('variant A: no tokens in client', s.tokens === undefined && s.userSub === undefined, `tokens=${String(s.tokens)}`);
	const subA = s.identityId!;

	const small = await uploadData({ path: ({ identityId }) => `private/${identityId}/hello.txt`, data: 'hello from A', options: { contentType: 'text/plain' } }).result;
	check('stock uploadData with identityId path callback', small.path === `private/${subA}/hello.txt`, small.path);

	let lastProgress = 0;
	const big = new Uint8Array(6 * 1024 * 1024); // > 5 MB: multipart upload
	const bigRes = await uploadData({
		path: ({ identityId }) => `private/${identityId}/big.bin`,
		data: big,
		options: { onProgress: ({ transferredBytes }) => { lastProgress = transferredBytes; } },
	}).result;
	const bigItem = (await list({ path: bigRes.path })).items.find((i) => i.path === bigRes.path);
	check('multipart uploadData (6 MB) lands intact', bigItem?.size === big.byteLength, `${bigRes.path} size=${bigItem?.size}`);
	// Node uses Amplify's fetch transfer handler (no progress events); browsers use XHR.
	info('onProgress under Node fetch handler', `${lastProgress} bytes reported`);

	const listed = await list({ path: ({ identityId }) => `private/${identityId}/` });
	check('stock list on own prefix', listed.items.length === 2, listed.items.map((i) => i.path).join(', '));

	const url = await getUrl({ path: `private/${subA}/hello.txt`, options: { expiresIn: 300 } });
	const viaUrl = await (await fetch(url.url)).text();
	check('stock getUrl presigned GET works', viaUrl === 'hello from A', viaUrl);

	const dl = await downloadData({ path: `private/${subA}/hello.txt` }).result;
	check('stock downloadData', (await dl.body.text()) === 'hello from A', 'hello from A');

	const pub = await list({ path: 'public/' });
	check('list on shared read-only prefix allowed', Array.isArray(pub.items), `${pub.items.length} item(s)`);

	// IAM is the enforcement point: same stock calls, other user's / read-only paths.
	try {
		await uploadData({ path: `private/${subB}/evil.txt`, data: 'x' }).result;
		check('cannot write another user\'s prefix (S3 enforces)', false, 'unexpectedly uploaded');
	} catch (e) {
		check('cannot write another user\'s prefix (S3 enforces)', /AccessDenied|Forbidden|403/i.test(errText(e)), errText(e));
	}
	try {
		await list({ path: `private/${subB}/` });
		check('cannot list another user\'s prefix (S3 enforces)', false, 'unexpectedly listed');
	} catch (e) {
		check('cannot list another user\'s prefix (S3 enforces)', /AccessDenied|Forbidden|403/i.test(errText(e)), errText(e));
	}
	try {
		await uploadData({ path: 'public/nope.txt', data: 'x' }).result;
		check('cannot write the shared read-only prefix (S3 enforces)', false, 'unexpectedly uploaded');
	} catch (e) {
		check('cannot write the shared read-only prefix (S3 enforces)', /AccessDenied|Forbidden|403/i.test(errText(e)), errText(e));
	}
	info('credential exchanges so far (cached for 14 min)', String(credentialCalls));

	// ---------------- Variant B: with short-lived JWTs (tokenProvider) --------
	configure('with-tokens', bucket);
	const sb = await fetchAuthSession();
	const sub = sb.tokens?.idToken?.payload.sub;
	check('variant B: tokens from Blocks session, userSub = identityId', sub === subA && sb.userSub === subA, `idToken.sub=${String(sub)}`);
	const refreshTok = (await rpc('session.getTokens', [{}])) as Record<string, unknown>;
	check('refresh token never reaches the client', !('refreshToken' in refreshTok) && Object.keys(refreshTok).sort().join() === 'accessToken,idToken', Object.keys(refreshTok).join(', '));

	// ---------------- Sign-out ---------------------------------------------
	await remove({ path: `private/${subA}/hello.txt` });
	await remove({ path: `private/${subA}/big.bin` });
	check('stock remove', (await list({ path: ({ identityId }) => `private/${identityId}/` })).items.length === 0, 'own prefix empty');

	const vended = cached!.credentials;
	await signOut();
	cookie = '';
	// Revocation lag: credentials already vended keep working until they expire.
	try {
		await uploadData({ path: `private/${subA}/after-signout.txt`, data: 'x' }).result;
		info('after Blocks sign-out, cached creds still upload (no clear)', `works until ${vended.expiration.toISOString()}`);
		await remove({ path: `private/${subA}/after-signout.txt` });
	} catch (e) {
		info('after Blocks sign-out, cached creds', errText(e));
	}
	credentialsProvider.clearCredentialsAndIdentityId();
	try {
		await uploadData({ path: `private/${subA}/after-clear.txt`, data: 'x' }).result;
		check('after sign-out + clearCredentials: no new credentials', false, 'unexpectedly uploaded');
	} catch (e) {
		check('after sign-out + clearCredentials: no new credentials', /401|NotAuthenticated|SessionExpired|NoCredentials/i.test(errText(e)), errText(e));
	}
} catch (e) {
	check('unexpected error', false, (e as Error).stack ?? String(e));
} finally {
	for (const u of [userA, userB]) {
		try { await idp.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: u.email })); } catch { /* not created */ }
	}
	info('cleanup', 'users A and B deleted');
}

for (const [name, status, detail] of results) console.log(`${status} ${name} — ${detail}`);
process.exit(failed ? 1 : 0);
