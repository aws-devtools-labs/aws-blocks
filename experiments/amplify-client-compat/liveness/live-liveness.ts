/**
 * Live test for the Face Liveness-on-Blocks POC, against a deployed stack.
 *
 *   node --experimental-websocket --import <tsx loader> live-liveness.ts <cdk outputs.json>
 *
 * Covers everything except a real face (that needs a camera; see README):
 * session ownership, credential scoping, and a real streaming handshake with
 * Rekognition using the component's own streaming client and Blocks-vended
 * credentials. Needs admin credentials in the environment to create and
 * delete the two test users.
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
	CognitoIdentityProviderClient,
	AdminCreateUserCommand,
	AdminSetUserPasswordCommand,
	AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { RekognitionClient, CreateFaceLivenessSessionCommand, GetFaceLivenessSessionResultsCommand } from '@aws-sdk/client-rekognition';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const outputsPath = process.argv[2];
if (!outputsPath) throw new Error('usage: live-liveness.ts <cdk outputs.json>');
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
const errText = (e: unknown) => `${(e as Error).name}: ${(e as Error).message}`;

let rpcId = 0;
async function rpc(method: string, params: unknown[], cookie = ''): Promise<{ result?: any; error?: any; setCookie: string[] }> {
	const res = await fetch(apiUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
		body: JSON.stringify({ jsonrpc: '2.0', method, params, id: ++rpcId }),
	});
	const body = (await res.json()) as { result?: unknown; error?: unknown };
	return { ...body, setCookie: res.headers.getSetCookie() };
}
async function blocksSignIn(username: string, password: string): Promise<string> {
	const r = await rpc('authApi.setAuthState', [{ action: 'signIn', username, password }]);
	if (r.error || r.result?.state !== 'signedIn') throw new Error(`Blocks signIn failed: ${JSON.stringify(r.error ?? r.result)}`);
	return r.setCookie.map((c) => c.split(';')[0]).join('; ');
}

const idp = new CognitoIdentityProviderClient({ region });
const mkUser = () => ({ email: `amp-lv-${randomBytes(4).toString('hex')}@example.com`, password: `Aa1!${randomBytes(12).toString('hex')}` });
const userA = mkUser();
const userB = mkUser();
async function createUser(u: { email: string; password: string }) {
	await idp.send(
		new AdminCreateUserCommand({
			UserPoolId: poolId,
			Username: u.email,
			MessageAction: 'SUPPRESS',
			UserAttributes: [{ Name: 'email', Value: u.email }, { Name: 'email_verified', Value: 'true' }],
		}),
	);
	await idp.send(new AdminSetUserPasswordCommand({ UserPoolId: poolId, Username: u.email, Password: u.password, Permanent: true }));
}

try {
	const anon = await rpc('liveness.createSession', []);
	check('createSession without a session is refused', anon.error?.code === 401, JSON.stringify(anon.error ?? anon.result));

	await createUser(userA);
	await createUser(userB);
	const cookieA = await blocksSignIn(userA.email, userA.password);
	const cookieB = await blocksSignIn(userB.email, userB.password);
	results.push(['Blocks sign-in (session cookie, no browser tokens)', 'PASS', 'users A and B']);

	// 1. A creates a session on the server.
	const created = await rpc('liveness.createSession', [], cookieA);
	const sessionId: string = created.result?.sessionId;
	check('A creates a liveness session (server-side)', /^[0-9a-f-]{36}$/.test(sessionId ?? ''), sessionId ?? JSON.stringify(created.error));

	// 2. Ownership: B can neither stream to nor read A's session; junk ids are refused.
	const bCreds = await rpc('liveness.getStreamingCredentials', [sessionId], cookieB);
	check('B cannot get streaming credentials for A\'s session', !!bCreds.error && !bCreds.result, bCreds.error?.message ?? 'granted');
	const bRes = await rpc('liveness.getResults', [sessionId], cookieB);
	check('B cannot read A\'s results', !!bRes.error && !bRes.result, bRes.error?.message ?? 'returned');
	const junk = await rpc('liveness.getResults', ['../../etc'], cookieA);
	check('malformed session id is refused', !!junk.error, junk.error?.message ?? 'accepted');

	// 3. A's streaming credentials: short-lived, vend role, streaming only.
	const c = (await rpc('liveness.getStreamingCredentials', [sessionId], cookieA)).result;
	const creds = { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken, expiration: new Date(c.expiration) };
	const ttlMin = (creds.expiration.getTime() - Date.now()) / 60000;
	check('credentials are short-lived', ttlMin > 0 && ttlMin <= 15, `${ttlMin.toFixed(1)} min`);
	const who = await new STSClient({ region, credentials: creds }).send(new GetCallerIdentityCommand({}));
	check('credentials are the vend role', /assumed-role\/[^/]+-liveness-vend\//.test(who.Arn ?? ''), who.Arn ?? '');
	const rekA = new RekognitionClient({ region, credentials: creds });
	let createDenied = 'unexpectedly succeeded';
	try {
		await rekA.send(new CreateFaceLivenessSessionCommand({}));
	} catch (e) {
		createDenied = errText(e);
	}
	check('credentials cannot create sessions', /AccessDenied/.test(createDenied), createDenied);
	let resultsDenied = 'unexpectedly succeeded';
	try {
		await rekA.send(new GetFaceLivenessSessionResultsCommand({ SessionId: sessionId }));
	} catch (e) {
		resultsDenied = errText(e);
	}
	check('credentials cannot read results (score stays server-side)', /AccessDenied/.test(resultsDenied), resultsDenied);

	// 4. Real streaming handshake with the component's own client and the vended credentials.
	const pkgDir = new URL('./node_modules/@aws-amplify/ui-react-liveness/', import.meta.url);
	const { createStreamingClient } = await import(
		new URL('dist/esm/components/FaceLivenessDetector/service/utils/createStreamingClient/createStreamingClient.mjs', pkgDir).href
	);
	let handshake = '';
	try {
		const client = await createStreamingClient({ credentialsProvider: async () => creds, region, attemptCount: 1, preCheckViewEnabled: true });
		// An empty request stream: we only need the service's first response event.
		const requestStream = (async function* () {
			await new Promise((r) => setTimeout(r, 8000));
		})();
		const stream = await client.getResponseStream({ requestStream, sessionId, videoWidth: '640', videoHeight: '480' });
		for await (const ev of stream) {
			handshake = Object.keys(ev).join(',');
			break;
		}
	} catch (e) {
		handshake = errText(e);
	}
	check(
		'vended credentials open a Rekognition streaming session (component client)',
		/ServerSessionInformationEvent|ChallengeEvent/.test(handshake),
		handshake || '(no event)',
	);

	// 5. Server-side scoring of a session that never received video.
	const r = (await rpc('liveness.getResults', [sessionId], cookieA)).result;
	check('A reads own results through the API', typeof r?.status === 'string', JSON.stringify(r));
} catch (e) {
	check('unexpected error', false, (e as Error).stack ?? String(e));
} finally {
	for (const u of [userA, userB]) {
		try {
			await idp.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: u.email }));
		} catch {
			/* user may not exist if creation failed */
		}
	}
	results.push(['cleanup AdminDeleteUser', 'INFO', 'users A and B']);
}

for (const [name, status, detail] of results) console.log(`${status} ${name} — ${detail}`);
process.exit(failed ? 1 : 0);
