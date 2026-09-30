/**
 * Live test for the StorageBrowser-on-Blocks POC. Drives the REAL Amplify UI
 * StorageBrowser action handlers (`defaultHandlers` from
 * `@aws-amplify/ui-react-storage/browser`, the same code the React component
 * runs) against a deployed stack, with credentials minted by the Blocks API.
 *
 *   usage: live-storage-browser.ts <cdk outputs.json>
 *
 * Needs admin credentials for the account in the environment (to create and
 * delete the two test users and to prove the negative S3 cases).
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { defaultHandlers } from '@aws-amplify/ui-react-storage/browser';
import {
	CognitoIdentityProviderClient,
	AdminCreateUserCommand,
	AdminSetUserPasswordCommand,
	AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const outputsPath = process.argv[2];
if (!outputsPath) throw new Error('usage: live-storage-browser.ts <cdk outputs.json>');
const out = Object.values(JSON.parse(readFileSync(outputsPath, 'utf-8')) as Record<string, Record<string, string>>)[0]!;
const apiUrl = out.ApiUrl!;
const region = out.AmplifyRegion!;
const poolId = out.AmplifyUserPoolId!;
const bucket = out.StorageBucketName!;

type Perm = 'get' | 'list' | 'write' | 'delete';
interface Creds { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: string }

const results: Array<[string, 'PASS' | 'FAIL' | 'INFO', string]> = [];
let failed = false;
const check = (name: string, ok: boolean, detail: string) => {
	results.push([name, ok ? 'PASS' : 'FAIL', detail]);
	if (!ok) failed = true;
};

// ---- Blocks JSON-RPC client (cookie session, no Cognito tokens) -------------
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
	for (const ns of ['authApi', 'auth']) {
		const r = await rpc(`${ns}.setAuthState`, [{ action: 'signIn', username, password }]);
		if (r.error?.code === -32601) continue; // method not found: try the other namespace name
		if (r.error) throw new Error(`Blocks signIn failed: ${JSON.stringify(r.error)}`);
		const cookie = r.setCookie.map((c) => c.split(';')[0]).join('; ');
		if (!cookie) throw new Error(`Blocks signIn returned no session cookie: ${JSON.stringify(r.result)}`);
		return cookie;
	}
	throw new Error('no auth namespace found');
}

const listLocations = (cookie: string) => rpc('storage.listLocations', [], cookie);
const getCreds = (cookie: string, scope: string, permissions: Perm[]) =>
	rpc('storage.getLocationCredentials', [{ scope, permissions }], cookie);

/** StorageBrowser ActionInputConfig backed by credentials from the Blocks API. */
function handlerConfig(creds: Creds, accountId: string) {
	return {
		accountId,
		bucket,
		region,
		credentials: async () => ({ credentials: { ...creds, expiration: new Date(creds.expiration) } }),
	};
}

// ---- Test users --------------------------------------------------------------
const idp = new CognitoIdentityProviderClient({ region });
const mkUser = () => ({
	email: `amp-sb-${randomBytes(4).toString('hex')}@example.com`,
	password: `Aa1!${randomBytes(12).toString('hex')}`,
});
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
	// 0. No session: the API refuses before minting anything.
	const anon = await listLocations('');
	check('listLocations without a session is refused', anon.error?.code === 401, JSON.stringify(anon.error ?? anon.result));

	await createUser(userA);
	await createUser(userB);
	const cookieA = await blocksSignIn(userA.email, userA.password);
	const cookieB = await blocksSignIn(userB.email, userB.password);
	results.push(['Blocks sign-in (session cookie, no browser tokens)', 'PASS', 'users A and B']);

	// 1. listLocations returns only the caller's own prefix plus the shared one.
	const locA = (await listLocations(cookieA)).result;
	const locB = (await listLocations(cookieB)).result;
	const prefixesA: string[] = locA.items.map((l: { prefix: string }) => l.prefix);
	const prefixA = prefixesA.find((p) => p.startsWith('private/'))!;
	const prefixB: string = locB.items.find((l: { id: string }) => l.id === 'mine').prefix;
	check(
		'listLocations: own prefix + shared, nothing else',
		prefixesA.length === 2 && prefixesA.includes('public/') && prefixA !== prefixB,
		prefixesA.join(', '),
	);
	const accountId: string = locA.accountId;

	// 2. B stores a file in B's own prefix through the real StorageBrowser upload handler.
	const credsB: Creds = (await getCreds(cookieB, `s3://${bucket}/${prefixB}*`, ['write'])).result.credentials;
	const secretKey = `${prefixB}secret.txt`;
	const upB = await defaultHandlers.upload({
		config: handlerConfig(credsB, accountId),
		data: { id: 'b1', key: secretKey, file: new File(['B only'], 'secret.txt', { type: 'text/plain' }) },
		all: [],
	}).result;
	check('B uploads to own prefix (real upload handler)', upB.status === 'COMPLETE', upB.status + (upB.message ? ` ${upB.message}` : ''));

	// 3. A: full lifecycle in A's prefix with the real handlers.
	const grantA = (await getCreds(cookieA, `s3://${bucket}/${prefixA}*`, ['get', 'list', 'write', 'delete'])).result;
	const credsA: Creds = grantA.credentials;
	const ttlMin = (new Date(credsA.expiration).getTime() - Date.now()) / 60000;
	check('credentials are short-lived', ttlMin > 0 && ttlMin <= 15, `${ttlMin.toFixed(1)} min`);
	const cfgA = handlerConfig(credsA, accountId);
	const helloKey = `${prefixA}hello.txt`;
	const upA = await defaultHandlers.upload({
		config: cfgA,
		data: { id: 'a1', key: helloKey, file: new File(['hello from A'], 'hello.txt', { type: 'text/plain' }) },
		all: [],
	}).result;
	check('A uploads to own prefix', upA.status === 'COMPLETE', upA.status + (upA.message ? ` ${upA.message}` : ''));
	const listed = await defaultHandlers.listLocationItems({ config: cfgA, prefix: prefixA, options: { delimiter: '/', pageSize: 100 } });
	check('A lists own prefix', listed.items.some((i) => i.key === helloKey), listed.items.map((i) => i.key).join(', ') || '(empty)');
	const del = await defaultHandlers.delete({ config: cfgA, data: { id: 'a1', key: helloKey }, all: [] }).result;
	check('A deletes own file', del.status === 'COMPLETE', del.status + (del.message ? ` ${del.message}` : ''));

	// 4. Server-side refusals: another user's prefix, and write on the read-only shared prefix.
	const crossScope = await getCreds(cookieA, `s3://${bucket}/${prefixB}*`, ['list', 'get']);
	check('API refuses credentials for another user\'s prefix', !!crossScope.error && !crossScope.result, JSON.stringify(crossScope.error));
	const sharedWrite = await getCreds(cookieA, `s3://${bucket}/public/*`, ['write']);
	check('API refuses write on the shared prefix', !!sharedWrite.error && !sharedWrite.result, JSON.stringify(sharedWrite.error));

	// 5. IAM-side refusals: even A's valid credentials cannot reach outside the granted scope.
	let crossList = 'unexpectedly succeeded';
	try {
		const r = await defaultHandlers.listLocationItems({ config: cfgA, prefix: prefixB, options: { delimiter: '/', pageSize: 100 } });
		crossList = `unexpectedly listed ${r.items.length} item(s)`;
	} catch (e) {
		crossList = `${(e as Error).name}: ${(e as Error).message}`;
	}
	check('A\'s credentials cannot list B\'s prefix (S3 enforces)', /AccessDenied|Forbidden|403/i.test(crossList), crossList);
	let crossGet = 'unexpectedly succeeded';
	try {
		const s3A = new S3Client({ region, credentials: { ...credsA, expiration: new Date(credsA.expiration) } });
		await s3A.send(new GetObjectCommand({ Bucket: bucket, Key: secretKey }));
	} catch (e) {
		crossGet = `${(e as Error).name}: ${(e as Error).message}`;
	}
	check('A\'s credentials cannot read B\'s file (S3 enforces)', /AccessDenied/i.test(crossGet), crossGet);
	const readOnly: Creds = (await getCreds(cookieA, `s3://${bucket}/public/*`, ['get', 'list'])).result.credentials;
	const roUp = await defaultHandlers.upload({
		config: handlerConfig(readOnly, accountId),
		data: { id: 'a2', key: 'public/nope.txt', file: new File(['x'], 'nope.txt') },
		all: [],
	}).result;
	check('read-only credentials cannot upload to shared (S3 enforces)', roUp.status === 'FAILED', `${roUp.status} ${roUp.message ?? ''}`);
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
