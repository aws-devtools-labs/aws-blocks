/**
 * Browser half of the token-exchange spike (candidate 4). Same flow as
 * `live-token-exchange.ts`, but in a real browser: the Blocks session cookie is
 * HttpOnly and handled by the browser (never visible to this code), and
 * `aws-amplify/storage` runs its browser build (XHR transfer handler, so
 * `onProgress` fires). Driven by `token-exchange-smoke.mjs`, which calls
 * `window.runSpike(...)` and reads back the results.
 */
// See live-token-exchange.ts: configure the core instance Storage actually uses.
import { Amplify, decodeJWT, fetchAuthSession } from '@aws-amplify/core';
import type { CredentialsAndIdentityIdProvider, TokenProvider } from '@aws-amplify/core';
import { uploadData, list, getUrl, downloadData, remove } from 'aws-amplify/storage';

declare const __API_PATH__: string;
declare const __REGION__: string;

type Result = [string, 'PASS' | 'FAIL' | 'INFO', string];

async function rpc(method: string, params: unknown[] = []): Promise<any> {
	const res = await fetch(__API_PATH__, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() }),
	});
	const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
	if (body.error) throw Object.assign(new Error(body.error.message), { name: `BlocksRpc${body.error.code}` });
	return body.result;
}
const signIn = (username: string, password: string) => rpc('authApi.setAuthState', [{ action: 'signIn', username, password }]);
const signOut = () => rpc('authApi.setAuthState', [{ action: 'signOut' }]);

let credentialCalls = 0;
let cached: { credentials: any; identityId: string } | undefined;
const credentialsProvider: CredentialsAndIdentityIdProvider = {
	async getCredentialsAndIdentityId({ forceRefresh }) {
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
const configure = (bucket: string, withTokens: boolean) =>
	Amplify.configure(
		{ Storage: { S3: { bucket, region: __REGION__ } } },
		{ Auth: { credentialsProvider, tokenProvider: withTokens ? tokenProvider : nullTokenProvider } },
	);

const errText = (e: unknown) => `${(e as Error).name}: ${(e as Error).message}`.slice(0, 160);
const denied = (e: unknown) => /AccessDenied|Forbidden|403/i.test(errText(e));
const unauth = (e: unknown) => /401|NotAuthenticated|SessionExpired|NoCredentials/i.test(errText(e));

async function runSpike(a: { email: string; password: string }, b: { email: string; password: string }): Promise<Result[]> {
	const results: Result[] = [];
	const check = (n: string, ok: boolean, d: string) => results.push([n, ok ? 'PASS' : 'FAIL', d]);
	const info = (n: string, d: string) => results.push([n, 'INFO', d]);
	const expectFail = async (n: string, f: () => Promise<unknown>, ok: (e: unknown) => boolean) => {
		try {
			await f();
			check(n, false, 'unexpectedly succeeded');
		} catch (e) {
			check(n, ok(e), errText(e));
		}
	};
	try {
		await signIn(b.email, b.password);
		const subB: string = (await rpc('session.getAwsCredentials')).identityId;
		const { bucket } = await rpc('session.getStorageConfig');
		await signOut();

		configure(bucket, false);
		await expectFail('signed out: uploadData has no credentials', () => uploadData({ path: 'public/anon.txt', data: 'x' }).result, unauth);

		await signIn(a.email, a.password);
		check('session cookie is HttpOnly (invisible to page JS)', !document.cookie.includes('auth_'), `document.cookie="${document.cookie}"`);
		credentialsProvider.clearCredentialsAndIdentityId();
		configure(bucket, false);
		const s = await fetchAuthSession();
		check('fetchAuthSession: identityId = sub, credentials, no tokens', !!s.identityId && !!s.credentials && s.tokens === undefined, `identityId=${s.identityId}`);
		const subA = s.identityId!;

		const small = await uploadData({ path: ({ identityId }) => `private/${identityId}/hello.txt`, data: 'hello from A', options: { contentType: 'text/plain' } }).result;
		check('stock uploadData with identityId path callback', small.path === `private/${subA}/hello.txt`, small.path);

		const big = new File([new Uint8Array(6 * 1024 * 1024)], 'big.bin');
		const progress: number[] = [];
		const up = await uploadData({
			path: ({ identityId }) => `private/${identityId}/big.bin`,
			data: big,
			options: { onProgress: ({ transferredBytes }) => progress.push(transferredBytes) },
		}).result;
		const bigItem = (await list({ path: up.path })).items.find((i) => i.path === up.path);
		check('multipart uploadData (6 MB File) lands intact', bigItem?.size === big.size, `size=${bigItem?.size}`);
		check('onProgress fires under the browser XHR handler', progress.length > 1 && progress[progress.length - 1] === big.size, `${progress.length} events, last=${progress[progress.length - 1]}`);

		const listed = await list({ path: ({ identityId }) => `private/${identityId}/` });
		check('stock list on own prefix', listed.items.length === 2, listed.items.map((i) => i.path.split('/').pop()).join(', '));
		const url = await getUrl({ path: `private/${subA}/hello.txt`, options: { expiresIn: 300 } });
		check('stock getUrl presigned GET (browser fetch, CORS)', (await (await fetch(url.url)).text()) === 'hello from A', 'hello from A');
		const dl = await downloadData({ path: `private/${subA}/hello.txt` }).result;
		check('stock downloadData', (await dl.body.text()) === 'hello from A', 'hello from A');

		await expectFail("cannot write another user's prefix (S3 enforces)", () => uploadData({ path: `private/${subB}/evil.txt`, data: 'x' }).result, denied);
		await expectFail("cannot list another user's prefix (S3 enforces)", () => list({ path: `private/${subB}/` }), denied);
		await expectFail('cannot write the shared read-only prefix (S3 enforces)', () => uploadData({ path: 'public/nope.txt', data: 'x' }).result, denied);

		configure(bucket, true);
		const sb = await fetchAuthSession();
		check('with tokenProvider: idToken.sub = identityId', sb.tokens?.idToken?.payload.sub === subA && sb.userSub === subA, `sub=${String(sb.tokens?.idToken?.payload.sub)}`);
		info('credential exchanges while signed in', String(credentialCalls - 1));

		await remove({ path: `private/${subA}/hello.txt` });
		await remove({ path: `private/${subA}/big.bin` });
		check('stock remove', (await list({ path: `private/${subA}/` })).items.length === 0, 'own prefix empty');

		await signOut();
		try {
			await uploadData({ path: `private/${subA}/after-signout.txt`, data: 'x' }).result;
			info('after sign-out, cached credentials still upload', `until ${cached!.credentials.expiration.toISOString()}`);
			await remove({ path: `private/${subA}/after-signout.txt` });
		} catch (e) {
			info('after sign-out, cached credentials', errText(e));
		}
		credentialsProvider.clearCredentialsAndIdentityId();
		await expectFail('after sign-out + clearCredentials: no new credentials', () => uploadData({ path: `private/${subA}/x.txt`, data: 'x' }).result, unauth);
	} catch (e) {
		check('unexpected error', false, (e as Error).stack ?? String(e));
	}
	return results;
}

(window as unknown as { runSpike: typeof runSpike }).runSpike = runSpike;
document.body.dataset.ready = '1';
