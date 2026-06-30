// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live AWS e2e suite for the AuthCognito Building Block.
 *
 * Unlike the mock-backed `auth-cognito.test.ts` (which reads verification
 * codes via `authCGetLastCode`), this suite provisions real Cognito users
 * via admin APIs — `AdminCreateUser` + `AdminSetUserPassword` + optional
 * `AdminAddUserToGroup` — and exercises every public AuthCognito method
 * against the deployed API Gateway endpoint via HTTP.
 *
 * Prerequisites:
 *   - A deployed `bb-test-*` sandbox stack with the comprehensive backend.
 *   - `AWS_PROFILE=hsinghvq-Admin` (or equivalent) with Cognito admin + CFN
 *     describe permissions.
 *   - Run from `test-apps/comprehensive` (reads `.blocks-sandbox/outputs.json`).
 *
 * The script does NOT call `authC.signIn(...)` directly — every assertion
 * goes through the Lambda-hosted Backend Building Block via fetch(), so
 * we exercise the full cookie/session round-trip the way the client does.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import {
	CognitoIdentityProviderClient,
	AdminCreateUserCommand,
	AdminSetUserPasswordCommand,
	AdminDeleteUserCommand,
	AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
	CloudFormationClient,
	DescribeStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SANDBOX_DIR = join(__dirname, '..', '.blocks-sandbox');
const REGION = process.env.AWS_REGION || 'us-east-1';
const STACK_NAME_ENV = process.env.BLOCKS_STACK_NAME;

// ─── Logging + test runner ───────────────────────────────────────────────────

const results: {
	name: string;
	status: 'pass' | 'fail' | 'skip';
	detail?: string;
}[] = [];

function log(msg: string) {
	console.log(`  ${msg}`);
}

async function runTest(name: string, fn: () => Promise<void>) {
	process.stdout.write(`• ${name} ... `);
	try {
		await fn();
		console.log('PASS');
		results.push({ name, status: 'pass' });
	} catch (e: any) {
		const detail = e?.message ?? String(e);
		console.log(`FAIL — ${detail}`);
		results.push({ name, status: 'fail', detail });
	}
}

async function skipTest(name: string, reason: string) {
	console.log(`• ${name} ... SKIP (${reason})`);
	results.push({ name, status: 'skip', detail: reason });
}

// ─── Bootstrap: read CDK outputs + discover pool IDs ─────────────────────────

interface StackInfo {
	stackName: string;
	apiUrl: string;
	authCPoolId: string;
	authCClientId: string;
	authCMfaPoolId: string;
	authCMfaClientId: string;
}

async function discoverStack(): Promise<StackInfo> {
	const outputsPath = join(SANDBOX_DIR, 'outputs.json');
	const outputs = JSON.parse(readFileSync(outputsPath, 'utf-8'));
	const stackName = STACK_NAME_ENV ?? Object.keys(outputs)[0];
	if (!stackName) throw new Error(`No stack in ${outputsPath}`);

	const stackOutputs = outputs[stackName] as Record<string, string>;
	const apiUrl = stackOutputs.ApiUrl;
	if (!apiUrl) throw new Error(`No ApiUrl in outputs for ${stackName}`);

	// Walk stack resources to locate each AuthCognito's UserPool + Client.
	// We can't rely on CfnOutputs — bb-auth-cognito doesn't emit any.
	const cfn = new CloudFormationClient({ region: REGION });
	const resources: {
		LogicalResourceId?: string;
		PhysicalResourceId?: string;
		ResourceType?: string;
	}[] = [];
	const firstPage = await cfn.send(new DescribeStackResourcesCommand({ StackName: stackName }));
	resources.push(...(firstPage.StackResources ?? []));

	const poolResources = resources.filter(
		(r) => r.ResourceType === 'AWS::Cognito::UserPool',
	);
	const clientResources = resources.filter(
		(r) => r.ResourceType === 'AWS::Cognito::UserPoolClient',
	);

	function findByName(arr: typeof resources, needle: string) {
		return arr.find((r) => (r.LogicalResourceId ?? '').toLowerCase().includes(needle));
	}

	const authCMfaPool = findByName(poolResources, 'authcmfa');
	const authCPool = poolResources.find((r) => r !== authCMfaPool);
	const authCMfaClient = findByName(clientResources, 'authcmfa');
	const authCClient = clientResources.find((r) => r !== authCMfaClient);

	if (!authCPool || !authCClient) throw new Error('could not locate authC pool/client');
	if (!authCMfaPool || !authCMfaClient) throw new Error('could not locate authCMfa pool/client');

	return {
		stackName,
		apiUrl,
		authCPoolId: authCPool.PhysicalResourceId!,
		authCClientId: authCClient.PhysicalResourceId!,
		authCMfaPoolId: authCMfaPool.PhysicalResourceId!,
		authCMfaClientId: authCMfaClient.PhysicalResourceId!,
	};
}

// ─── HTTP client (cookie jar per session) ────────────────────────────────────

class ApiSession {
	private cookies = new Map<string, string>();
	constructor(private apiUrl: string, private namespace = 'api') {}

	reset() {
		this.cookies.clear();
	}

	private cookieHeader(): string | undefined {
		if (this.cookies.size === 0) return undefined;
		return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
	}

	private absorbSetCookie(headers: Headers) {
		// Node's fetch joins multiple Set-Cookie values with a comma. Parse
		// each Set-Cookie pair at the top-level (before any `;`), not after
		// a comma inside an Expires=... date.
		const raw = (headers as any).getSetCookie?.() ??
			(headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
		for (const v of raw) {
			const firstSemi = v.indexOf(';');
			const kv = firstSemi === -1 ? v : v.slice(0, firstSemi);
			const eq = kv.indexOf('=');
			if (eq < 0) continue;
			const name = kv.slice(0, eq).trim();
			const value = kv.slice(eq + 1).trim();
			if (!value) this.cookies.delete(name);
			else this.cookies.set(name, value);
		}
	}

	async call<T = any>(method: string, args: any[] = []): Promise<T> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		const ch = this.cookieHeader();
		if (ch) headers['Cookie'] = ch;
		const res = await fetch(this.apiUrl, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: `${this.namespace}.${method}`,
				params: args,
				id: 1,
			}),
		});
		this.absorbSetCookie(res.headers);
		const text = await res.text();
		let body: any;
		try { body = JSON.parse(text); } catch { body = text; }
		if (!res.ok || body?.error) {
			const errPayload = body?.error ?? {};
			const err: any = new Error(errPayload.message ?? body?.error ?? res.statusText);
			err.status = errPayload.code && errPayload.code > 0 ? errPayload.code : res.status;
			err.name = errPayload.data?.name ?? body?.name ?? err.name;
			throw err;
		}
		return body.result as T;
	}
}

function isBlocksErrName(e: any, ...names: string[]): boolean {
	return names.includes(e?.name);
}

// ─── TOTP (RFC 6238) ─────────────────────────────────────────────────────────

function base32Decode(input: string): Buffer {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	const cleaned = input.replace(/=+$/g, '').toUpperCase();
	let bits = 0n;
	let length = 0;
	for (const ch of cleaned) {
		const idx = alphabet.indexOf(ch);
		if (idx < 0) throw new Error(`bad base32 char: ${ch}`);
		bits = (bits << 5n) | BigInt(idx);
		length += 5;
	}
	const bytes: number[] = [];
	for (let i = length - 8; i >= 0; i -= 8) {
		bytes.push(Number((bits >> BigInt(i)) & 0xffn));
	}
	return Buffer.from(bytes);
}

function totp(secret: string, step = 30, digits = 6, t = Date.now()): string {
	const key = base32Decode(secret);
	const counter = Math.floor(t / 1000 / step);
	const buf = Buffer.alloc(8);
	buf.writeBigUInt64BE(BigInt(counter));
	const h = createHmac('sha1', key).update(buf).digest();
	const offset = h[h.length - 1] & 0x0f;
	const bin =
		((h[offset] & 0x7f) << 24) |
		((h[offset + 1] & 0xff) << 16) |
		((h[offset + 2] & 0xff) << 8) |
		(h[offset + 3] & 0xff);
	return (bin % 10 ** digits).toString().padStart(digits, '0');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	console.log('─── Discovering deployed stack ───');
	const stack = await discoverStack();
	console.log(`  Stack:          ${stack.stackName}`);
	console.log(`  API URL:        ${stack.apiUrl}`);
	console.log(`  authC pool:     ${stack.authCPoolId}`);
	console.log(`  authC client:   ${stack.authCClientId}`);
	console.log(`  authCMfa pool:  ${stack.authCMfaPoolId}`);
	console.log(`  authCMfa client:${stack.authCMfaClientId}`);

	const cog = new CognitoIdentityProviderClient({ region: REGION });

	async function createUser(poolId: string, username: string, password: string, email: string, extraAttrs: Array<{Name: string; Value: string}> = []) {
		await cog.send(new AdminCreateUserCommand({
			UserPoolId: poolId,
			Username: username,
			TemporaryPassword: password + 'Temp!',
			MessageAction: 'SUPPRESS',
			UserAttributes: [
				{ Name: 'email', Value: email },
				{ Name: 'email_verified', Value: 'true' },
				...extraAttrs,
			],
		}));
		await cog.send(new AdminSetUserPasswordCommand({
			UserPoolId: poolId,
			Username: username,
			Password: password,
			Permanent: true,
		}));
	}
	async function deleteUser(poolId: string, username: string) {
		try {
			await cog.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: username }));
		} catch {}
	}
	async function addToGroup(poolId: string, username: string, group: string) {
		await cog.send(new AdminAddUserToGroupCommand({
			UserPoolId: poolId, Username: username, GroupName: group,
		}));
	}

	const RUN_ID = Date.now().toString(36);
	let counter = 0;
	const mkUser = () => `adm-${RUN_ID}-${counter++}`;

	const createdUsers: { pool: string; username: string }[] = [];

	// ─── signIn + session ─────────────────────────────────────────────────
	console.log('\n─── signIn + session ───');
	{
		const username = mkUser();
		const email = `${username}@example.com`;
		await createUser(stack.authCPoolId, username, 'Password1!', email);
		createdUsers.push({ pool: stack.authCPoolId, username });

		await runTest('signIn with valid creds issues a session', async () => {
			const s = new ApiSession(stack.apiUrl);
			const r = await s.call('authCSignIn', [username, 'Password1!']);
			if (r.status !== 'signedIn') throw new Error(`expected status=signedIn, got ${JSON.stringify(r)}`);
			if (r.user.username !== username) throw new Error(`username mismatch: ${r.user.username}`);
			await s.call('authCSignOut');
		});

		await runTest('wrong password → NotAuthorizedException', async () => {
			const s = new ApiSession(stack.apiUrl);
			try {
				await s.call('authCSignIn', [username, 'Wrong!1234']);
				throw new Error('expected failure');
			} catch (e: any) {
				if (!isBlocksErrName(e, 'NotAuthorizedException')) throw e;
			}
		});

		await runTest('getCurrentUser after signIn returns user', async () => {
			const s = new ApiSession(stack.apiUrl);
			await s.call('authCSignIn', [username, 'Password1!']);
			const u = await s.call('authCGetCurrentUser');
			if (!u || u.username !== username) throw new Error(`bad user: ${JSON.stringify(u)}`);
			await s.call('authCSignOut');
		});

		await runTest('checkAuth true after signIn / false after signOut', async () => {
			const s = new ApiSession(stack.apiUrl);
			await s.call('authCSignIn', [username, 'Password1!']);
			if ((await s.call('authCCheckAuth')) !== true) throw new Error('expected true');
			await s.call('authCSignOut');
			if ((await s.call('authCCheckAuth')) !== false) throw new Error('expected false');
		});

		await runTest('requireAuth without session → NotAuthenticatedException', async () => {
			const s = new ApiSession(stack.apiUrl);
			try {
				await s.call('authCRequireAuth');
				throw new Error('expected failure');
			} catch (e: any) {
				if (!isBlocksErrName(e, 'NotAuthenticatedException')) throw e;
			}
		});

		await runTest('signOut is idempotent', async () => {
			const s = new ApiSession(stack.apiUrl);
			await s.call('authCSignOut');
			await s.call('authCSignOut');
			if ((await s.call('authCCheckAuth')) !== false) throw new Error('expected false');
		});

		await runTest('global signOut returns without error', async () => {
			const s = new ApiSession(stack.apiUrl);
			await s.call('authCSignIn', [username, 'Password1!']);
			await s.call('authCSignOut', [{ global: true }]);
			if ((await s.call('authCCheckAuth')) !== false) throw new Error('expected false');
		});
	}

	// ─── fetchAuthSession + fetchUserAttributes ──────────────────────────
	console.log('\n─── fetchAuthSession + fetchUserAttributes ───');
	{
		const username = mkUser();
		const email = `${username}@example.com`;
		await createUser(stack.authCPoolId, username, 'Password1!', email, [
			{ Name: 'custom:department', Value: 'eng' },
		]);
		createdUsers.push({ pool: stack.authCPoolId, username });

		await runTest('fetchAuthSession returns real JWTs with narrowed sub claim', async () => {
			const s = new ApiSession(stack.apiUrl);
			await s.call('authCSignIn', [username, 'Password1!']);
			const sess = await s.call('authCFetchAuthSession');
			if (sess.status !== 'signedIn') throw new Error('expected signedIn');
			if (!sess.idToken || sess.idToken.length < 20) throw new Error('bad idToken');
			if (!sess.accessToken || sess.accessToken.length < 20) throw new Error('bad accessToken');
			if (!/^[0-9a-f-]{36}$/.test(sess.userSub)) throw new Error(`userSub not a UUID: ${sess.userSub}`);
			if (sess.subType !== 'string') throw new Error(`bad subType: ${sess.subType}`);
			if (!sess.subFromPayload) throw new Error('missing subFromPayload');
			if (typeof sess.idTokenExpiresAt !== 'number') throw new Error('expiresAt not a number');
			const now = Date.now();
			// Cognito default access/id token lifetime is 1h = 3600s.
			if (sess.idTokenExpiresAt < now || sess.idTokenExpiresAt > now + 2 * 3600 * 1000) {
				throw new Error(`expiresAt out of range: ${sess.idTokenExpiresAt - now}ms from now`);
			}
			await s.call('authCSignOut');
		});

		await runTest('fetchUserAttributes returns email + custom:department', async () => {
			const s = new ApiSession(stack.apiUrl);
			await s.call('authCSignIn', [username, 'Password1!']);
			const attrs = await s.call('authCFetchUserAttributes');
			if (attrs.email !== email) throw new Error(`email mismatch: ${attrs.email}`);
			if (attrs['custom:department'] !== 'eng') throw new Error(`department mismatch: ${attrs['custom:department']}`);
			await s.call('authCSignOut');
		});

		await runTest('fetchAuthSession signed-out → signedIn=false', async () => {
			const s = new ApiSession(stack.apiUrl);
			const sess = await s.call('authCFetchAuthSession');
			if (sess.status !== 'signedOut') throw new Error(`expected false, got ${JSON.stringify(sess)}`);
		});
	}

	// ─── updatePassword + updateUserAttributes ──────────────────────────
	console.log('\n─── updatePassword + updateUserAttributes ───');
	{
		const username = mkUser();
		const email = `${username}@example.com`;
		await createUser(stack.authCPoolId, username, 'Password1!', email, [
			{ Name: 'custom:department', Value: 'eng' },
		]);
		createdUsers.push({ pool: stack.authCPoolId, username });

		await runTest('updatePassword with wrong old password → NotAuthorizedException', async () => {
			const s = new ApiSession(stack.apiUrl);
			await s.call('authCSignIn', [username, 'Password1!']);
			try {
				await s.call('authCUpdatePassword', ['Wrong!1234', 'New!Password2']);
				throw new Error('expected failure');
			} catch (e: any) {
				if (!isBlocksErrName(e, 'NotAuthorizedException')) throw e;
			}
			await s.call('authCSignOut');
		});

		await runTest('updatePassword lets the user sign in with new password', async () => {
			const s = new ApiSession(stack.apiUrl);
			await s.call('authCSignIn', [username, 'Password1!']);
			await s.call('authCUpdatePassword', ['Password1!', 'Rotated!Pw9']);
			await s.call('authCSignOut');
			try {
				await s.call('authCSignIn', [username, 'Password1!']);
				throw new Error('old password should be rejected');
			} catch (e: any) {
				if (!isBlocksErrName(e, 'NotAuthorizedException')) throw e;
			}
			const r = await s.call('authCSignIn', [username, 'Rotated!Pw9']);
			if (r.status !== 'signedIn') throw new Error('new password rejected');
			await s.call('authCSignOut');
			await cog.send(new AdminSetUserPasswordCommand({
				UserPoolId: stack.authCPoolId, Username: username, Password: 'Password1!', Permanent: true,
			}));
		});

		await runTest('updateUserAttributes(custom:department) round-trips', async () => {
			const s = new ApiSession(stack.apiUrl);
			await s.call('authCSignIn', [username, 'Password1!']);
			await s.call('authCUpdateUserAttributes', [{ 'custom:department': 'platform' }]);
			const attrs = await s.call('authCFetchUserAttributes');
			if (attrs['custom:department'] !== 'platform') throw new Error(`mismatch: ${attrs['custom:department']}`);
			await s.call('authCSignOut');
		});

		await runTest('updateUserAttributes(email) returns CONFIRM_ATTRIBUTE_WITH_CODE', async () => {
			const s = new ApiSession(stack.apiUrl);
			await s.call('authCSignIn', [username, 'Password1!']);
			const r = await s.call('authCUpdateUserAttributes', [{ email: 'new@example.com' }]);
			const out = r.email;
			if (!out) throw new Error(`missing email outcome: ${JSON.stringify(r)}`);
			if (out.isUpdated !== false) throw new Error(`expected isUpdated=false, got ${JSON.stringify(out)}`);
			if (out.nextStep?.name !== 'CONFIRM_ATTRIBUTE_WITH_CODE') {
				throw new Error(`unexpected nextStep: ${JSON.stringify(out.nextStep)}`);
			}
			await s.call('authCSignOut');
		});

		await skipTest(
			'confirmUserAttribute',
			'not exposed in comprehensive API surface AND requires capturing the email verification code (no SES/mailbox plumbing)',
		);
		await skipTest(
			'sendUserAttributeVerificationCode',
			'not exposed in comprehensive API surface; would fire-and-forget the email anyway',
		);
	}

	// ─── requireRole ─────────────────────────────────────────────────────
	console.log('\n─── requireRole ───');
	{
		const adminUsername = mkUser();
		const readerUsername = mkUser();
		await createUser(stack.authCPoolId, adminUsername, 'Password1!', `${adminUsername}@example.com`);
		await createUser(stack.authCPoolId, readerUsername, 'Password1!', `${readerUsername}@example.com`);
		await addToGroup(stack.authCPoolId, adminUsername, 'admins');
		await addToGroup(stack.authCPoolId, readerUsername, 'readers');
		createdUsers.push({ pool: stack.authCPoolId, username: adminUsername });
		createdUsers.push({ pool: stack.authCPoolId, username: readerUsername });

		await runTest('requireRole(admins) succeeds for an admin user', async () => {
			const s = new ApiSession(stack.apiUrl);
			await s.call('authCSignIn', [adminUsername, 'Password1!']);
			const u = await s.call('authCRequireRole', ['admins']);
			if (u.username !== adminUsername) throw new Error(`bad user: ${u.username}`);
			await s.call('authCSignOut');
		});

		await runTest('requireRole(admins) 403 for a reader user', async () => {
			const s = new ApiSession(stack.apiUrl);
			await s.call('authCSignIn', [readerUsername, 'Password1!']);
			try {
				await s.call('authCRequireRole', ['admins']);
				throw new Error('expected failure');
			} catch (e: any) {
				if (!isBlocksErrName(e, 'NotAuthorizedException')) throw e;
				if (e.status !== 403) throw new Error(`expected 403, got ${e.status}`);
			}
			await s.call('authCSignOut');
		});

		await runTest('requireRole without session → 401 NotAuthenticatedException', async () => {
			const s = new ApiSession(stack.apiUrl);
			try {
				await s.call('authCRequireRole', ['admins']);
				throw new Error('expected failure');
			} catch (e: any) {
				if (!isBlocksErrName(e, 'NotAuthenticatedException')) throw e;
				if (e.status !== 401) throw new Error(`expected 401, got ${e.status}`);
			}
		});

		await runTest('requireRole(readers) succeeds for a reader user', async () => {
			const s = new ApiSession(stack.apiUrl);
			await s.call('authCSignIn', [readerUsername, 'Password1!']);
			const u = await s.call('authCRequireRole', ['readers']);
			if (u.username !== readerUsername) throw new Error(`bad user: ${u.username}`);
			await s.call('authCSignOut');
		});
	}

	// ─── resetPassword (skip on real AWS without a mailbox) ──────────────
	console.log('\n─── resetPassword ───');
	await skipTest(
		'resetPassword + confirmResetPassword',
		'requires SES-captured mailbox to read the Cognito-sent reset code; no mailbox available in this sandbox',
	);

	// ─── MFA / TOTP (on authCMfa pool) ───────────────────────────────────
	console.log('\n─── MFA / TOTP (authCMfa pool) ───');
	{
		const username = mkUser();
		await createUser(stack.authCMfaPoolId, username, 'Password1!', `${username}@example.com`);
		createdUsers.push({ pool: stack.authCMfaPoolId, username });

		let sharedSecret = '';
		await runTest('setUpTOTP returns a base32 shared secret', async () => {
			const s = new ApiSession(stack.apiUrl);
			const r1 = await s.call('authCMfaSignIn', [username, 'Password1!']);
			if (r1.status !== 'signedIn') throw new Error(`unexpected challenge on first sign-in: ${JSON.stringify(r1)}`);
			const r = await s.call('authCMfaSetUpTOTP');
			if (!r.sharedSecret || !/^[A-Z2-7]+=*$/.test(r.sharedSecret)) {
				throw new Error(`bad sharedSecret: ${r.sharedSecret}`);
			}
			sharedSecret = r.sharedSecret;
			await s.call('authCMfaSignOut');
		});

		// Helper: wait for the next TOTP window so we never send a code twice.
		// Cognito's VerifySoftwareToken + RespondToAuthChallenge reject a
		// previously-seen code in the same 30-second step with
		// `EnableSoftwareTokenMFAException: Your software token has already
		// been used once` even if it was correct. Between any two calls that
		// consume a TOTP we must cross a step boundary.
		async function waitNextTotpStep() {
			const step = 30;
			const msIntoStep = (Date.now() / 1000) % step;
			const waitMs = (step - msIntoStep) * 1000 + 500; // 500ms slack
			await new Promise((r) => setTimeout(r, waitMs));
		}

		await runTest('verifyTOTPSetup + updateMFAPreference enables TOTP factor', async () => {
			const s = new ApiSession(stack.apiUrl);
			await s.call('authCMfaSignIn', [username, 'Password1!']);
			const r = await s.call('authCMfaSetUpTOTP');
			sharedSecret = r.sharedSecret;
			await waitNextTotpStep();
			const code = totp(sharedSecret);
			await s.call('authCMfaVerifyTOTPSetup', [code]);
			// Real Cognito: VerifySoftwareToken does NOT automatically add
			// TOTP to UserMFASettingList. You must follow up with
			// SetUserMFAPreference (what updateMFAPreference calls).
			await s.call('authCMfaUpdateMFAPreference', [{ totp: 'PREFERRED' }]);
			const pref = await s.call('authCMfaFetchMFAPreference');
			if (!pref.enabled?.includes('TOTP')) {
				throw new Error(`TOTP not enabled after verify+preference: ${JSON.stringify(pref)}`);
			}
			if (pref.preferred !== 'TOTP') {
				throw new Error(`expected TOTP preferred, got ${JSON.stringify(pref)}`);
			}
			await s.call('authCMfaSignOut');
		});

		await runTest('end-to-end: signIn → CONFIRM_SIGN_IN_WITH_TOTP_CODE → complete with RFC-6238 code', async () => {
			const s = new ApiSession(stack.apiUrl);
			const r1 = await s.call('authCMfaSignIn', [username, 'Password1!']);
			if (r1.status === 'signedIn') throw new Error(`expected TOTP challenge, got status=signedIn`);
			if (r1.nextStep?.name !== 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') {
				throw new Error(`unexpected nextStep: ${JSON.stringify(r1.nextStep)}`);
			}
			await waitNextTotpStep();
			const code = totp(sharedSecret);
			const r2 = await s.call('authCMfaConfirmSignIn', [r1.nextStep.session, code]);
			if (r2.status !== 'signedIn') throw new Error(`confirmSignIn failed: ${JSON.stringify(r2)}`);
			await s.call('authCMfaSignOut');
		});

		await runTest('updateMFAPreference({totp: DISABLED}) removes TOTP', async () => {
			const s = new ApiSession(stack.apiUrl);
			const r1 = await s.call('authCMfaSignIn', [username, 'Password1!']);
			if (r1.status !== 'signedIn') {
				await waitNextTotpStep();
				const code = totp(sharedSecret);
				const r2 = await s.call('authCMfaConfirmSignIn', [r1.nextStep.session, code]);
				if (r2.status !== 'signedIn') throw new Error(`confirmSignIn failed: ${JSON.stringify(r2)}`);
			}
			await s.call('authCMfaUpdateMFAPreference', [{ totp: 'DISABLED' }]);
			const pref = await s.call('authCMfaFetchMFAPreference');
			if (pref.enabled?.includes('TOTP')) throw new Error(`TOTP still enabled: ${JSON.stringify(pref)}`);
			await s.call('authCMfaSignOut');
		});

		const neverEnrolled = mkUser();
		await createUser(stack.authCMfaPoolId, neverEnrolled, 'Password1!', `${neverEnrolled}@example.com`);
		createdUsers.push({ pool: stack.authCMfaPoolId, username: neverEnrolled });
		await runTest('updateMFAPreference({totp: PREFERRED}) on un-enrolled user throws', async () => {
			const s = new ApiSession(stack.apiUrl);
			const r1 = await s.call('authCMfaSignIn', [neverEnrolled, 'Password1!']);
			if (r1.status !== 'signedIn') throw new Error(`unexpected challenge: ${JSON.stringify(r1)}`);
			try {
				await s.call('authCMfaUpdateMFAPreference', [{ totp: 'PREFERRED' }]);
				throw new Error('expected failure');
			} catch (e: any) {
				// Mock: SoftwareTokenMFANotFoundException
				// Real Cognito: InvalidParameterException
				//   "User does not have delivery config set to turn on SOFTWARE_TOKEN_MFA"
				// Both are legitimate guards — accept either so the test is
				// portable across mock + AWS.
				const ok = isBlocksErrName(e, 'SoftwareTokenMFANotFoundException', 'InvalidParameterException');
				if (!ok) throw e;
			}
			await s.call('authCMfaSignOut');
		});
	}

	// ─── Devices ─────────────────────────────────────────────────────────
	console.log('\n─── Devices ───');
	{
		const username = mkUser();
		await createUser(stack.authCPoolId, username, 'Password1!', `${username}@example.com`);
		createdUsers.push({ pool: stack.authCPoolId, username });

		await runTest('fetchDevices returns empty (or fails NotAuthorized) when device tracking is off', async () => {
			const s = new ApiSession(stack.apiUrl);
			await s.call('authCSignIn', [username, 'Password1!']);
			// The BB doesn't set `DeviceConfiguration` on the pool, so real
			// Cognito responds with `InvalidParameterException: Device
			// tracking not currently enabled for this pool.` on ListDevices.
			// The mock returns []. Accept either behavior — both are the
			// correct surface shape for a no-devices state.
			try {
				const devices = await s.call('authCFetchDevices');
				if (!Array.isArray(devices) || devices.length !== 0) {
					throw new Error(`expected [], got ${JSON.stringify(devices)}`);
				}
			} catch (e: any) {
				if (!/device tracking/i.test(e.message || '')) throw e;
			}
			await s.call('authCSignOut');
		});

		await runTest('rememberDevice throws 501 (NewDeviceMetadata plumbing unimplemented)', async () => {
			const s = new ApiSession(stack.apiUrl);
			await s.call('authCSignIn', [username, 'Password1!']);
			try {
				await s.call('authCRememberDevice');
				throw new Error('expected 501 failure');
			} catch (e: any) {
				if (e.status !== 501) throw new Error(`expected 501, got ${e.status}: ${e.message}`);
				if (!/NewDeviceMetadata/i.test(e.message || '')) {
					throw new Error(`expected NewDeviceMetadata in message, got: ${e.message}`);
				}
			}
			await s.call('authCSignOut');
		});

		await runTest('forgetDevice with well-formed unknown key does not blow up', async () => {
			const s = new ApiSession(stack.apiUrl);
			await s.call('authCSignIn', [username, 'Password1!']);
			// Mock (no-op on missing key) ≠ real AWS. On this sandbox pool
			// device tracking is OFF, so Cognito responds with
			// `InvalidParameterException: Device tracking not currently
			// enabled for this pool.`. Also accept `ResourceNotFoundException`
			// (the legit "key doesn't exist" path on a tracking-enabled pool).
			// The assertion is that the BB doesn't barf on an absent device.
			try {
				await s.call('authCForgetDevice', ['us-east-1_00000000-0000-0000-0000-000000000000']);
			} catch (e: any) {
				const ok = isBlocksErrName(e, 'ResourceNotFoundException', 'InvalidParameterException')
					|| /device tracking/i.test(e.message ?? '');
				if (!ok) throw e;
			}
			await s.call('authCSignOut');
		});
	}

	// ─── deleteUser ──────────────────────────────────────────────────────
	console.log('\n─── deleteUser ───');
	{
		const username = mkUser();
		await createUser(stack.authCPoolId, username, 'Password1!', `${username}@example.com`);

		await runTest('deleteUser removes the user; subsequent signIn fails', async () => {
			const s = new ApiSession(stack.apiUrl);
			await s.call('authCSignIn', [username, 'Password1!']);
			await s.call('authCDeleteUser');
			try {
				await s.call('authCSignIn', [username, 'Password1!']);
				throw new Error('expected sign-in to fail after deleteUser');
			} catch (e: any) {
				if (!isBlocksErrName(e, 'NotAuthorizedException', 'UserNotFoundException')) throw e;
			}
		});
	}

	// ─── Cleanup ─────────────────────────────────────────────────────────
	console.log('\n─── Cleanup: deleting admin-created users ───');
	for (const { pool, username } of createdUsers) {
		await deleteUser(pool, username);
	}
	log(`Deleted ${createdUsers.length} user(s).`);

	// ─── Summary ─────────────────────────────────────────────────────────
	const pass = results.filter((r) => r.status === 'pass').length;
	const fail = results.filter((r) => r.status === 'fail').length;
	const skip = results.filter((r) => r.status === 'skip').length;
	console.log(`\n=== Summary: ${pass} pass · ${fail} fail · ${skip} skip (${results.length} total) ===`);
	if (fail > 0) {
		console.log('\nFailures:');
		for (const r of results.filter((r) => r.status === 'fail')) {
			console.log(`  • ${r.name}: ${r.detail}`);
		}
	}
	process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error('Fatal error:', e);
	process.exit(2);
});
