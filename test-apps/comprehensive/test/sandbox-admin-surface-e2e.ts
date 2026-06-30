// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live AWS e2e suite for the opt-in `auth.admin` surface on AuthCognito.
 *
 * Unlike `sandbox-admin-e2e.ts` (which provisions users via the raw Cognito
 * SDK to test the *client* methods), this suite drives the BB's own
 * `auth.admin.*` operations through the deployed Lambda backend over HTTP —
 * the routes wired in `aws-blocks/index.ts` (`authCAdmin*`). It verifies the
 * admin IAM grant is present and the surface behaves end-to-end.
 *
 * Prerequisites (same as sandbox-admin-e2e):
 *   - A deployed `bb-test-*` sandbox with the comprehensive backend, built
 *     with `admin: {}` on the `authC` pool (already set in aws-blocks/index.ts).
 *   - `AWS_PROFILE` with Cognito admin + CFN-describe permissions.
 *   - Run from `test-apps/comprehensive` (reads `.blocks-sandbox/outputs.json`).
 *
 * Run:  node --import tsx test/sandbox-admin-surface-e2e.ts
 * (NOT part of the unit-test run — requires a live deployment.)
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	CloudFormationClient,
	DescribeStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';

const SANDBOX_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.blocks-sandbox');
const REGION = process.env.AWS_REGION || 'us-east-1';
const STACK_NAME_ENV = process.env.BLOCKS_STACK_NAME;

const results: { name: string; status: 'pass' | 'fail'; detail?: string }[] = [];

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

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

async function discoverApiUrl(): Promise<string> {
	const outputs = JSON.parse(readFileSync(join(SANDBOX_DIR, 'outputs.json'), 'utf-8'));
	const stackName = STACK_NAME_ENV ?? Object.keys(outputs)[0];
	if (!stackName) throw new Error('No stack in outputs.json');
	const apiUrl = (outputs[stackName] as Record<string, string>).ApiUrl;
	if (!apiUrl) throw new Error(`No ApiUrl for ${stackName}`);
	// Touch CFN so a misconfigured profile fails loudly here, not mid-suite.
	await new CloudFormationClient({ region: REGION })
		.send(new DescribeStackResourcesCommand({ StackName: stackName }));
	return apiUrl;
}

/** Minimal JSON-RPC client with cookie jar (mirrors sandbox-admin-e2e). */
class ApiSession {
	private cookies = new Map<string, string>();
	constructor(private apiUrl: string, private namespace = 'api') {}
	reset() { this.cookies.clear(); }
	private cookieHeader(): string | undefined {
		if (this.cookies.size === 0) return undefined;
		return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
	}
	private absorb(headers: Headers) {
		const raw = (headers as any).getSetCookie?.() ??
			(headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
		for (const v of raw) {
			const kv = v.slice(0, v.indexOf(';') === -1 ? undefined : v.indexOf(';'));
			const eq = kv.indexOf('=');
			if (eq < 0) continue;
			const name = kv.slice(0, eq).trim();
			const value = kv.slice(eq + 1).trim();
			if (!value) this.cookies.delete(name); else this.cookies.set(name, value);
		}
	}
	async call<T = any>(method: string, args: any[] = []): Promise<T> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		const ch = this.cookieHeader();
		if (ch) headers['Cookie'] = ch;
		const res = await fetch(this.apiUrl, {
			method: 'POST', headers,
			body: JSON.stringify({ jsonrpc: '2.0', method: `${this.namespace}.${method}`, params: args, id: 1 }),
		});
		this.absorb(res.headers);
		const text = await res.text();
		let body: any; try { body = JSON.parse(text); } catch { body = text; }
		if (!res.ok || body?.error) {
			const p = body?.error ?? {};
			const err: any = new Error(p.message ?? body?.error ?? res.statusText);
			err.status = p.code && p.code > 0 ? p.code : res.status;
			err.name = p.data?.name ?? body?.name ?? err.name;
			throw err;
		}
		return body.result as T;
	}
}

async function main() {
	console.log('─── auth.admin surface e2e ───');
	const apiUrl = await discoverApiUrl();
	console.log(`  API URL: ${apiUrl}`);

	const s = new ApiSession(apiUrl);
	const uniq = (process.env.BLOCKS_TEST_SEED ?? String(process.hrtime.bigint())).slice(-8);
	const alice = `admin-e2e-alice-${uniq}`;
	const bob = `admin-e2e-bob-${uniq}`;
	const PW = 'AdminE2e!1';

	await runTest('admin.createUser creates a real user', async () => {
		const r = await s.call('authCAdminCreateUser', [alice, PW]);
		assert(r.username === alice, `expected ${alice}, got ${r.username}`);
		assert(r.enabled === true, 'new user should be enabled');
	});

	await runTest('admin.setUserPassword(permanent) lets the user sign in', async () => {
		await s.call('authCAdminSetPassword', [alice, PW]);
		const r = await s.call('authCSignIn', [alice, PW]);
		assert(r.status === 'signedIn', `expected signedIn, got ${r.status}`);
		s.reset();
	});

	await runTest('admin.addUserToGroup → requireRole(admins) succeeds on fresh token', async () => {
		await s.call('authCAdminAddToGroup', [alice, 'admins']);
		const groups = await s.call('authCAdminListGroupsForUser', [alice]);
		assert(Array.isArray(groups) && groups.includes('admins'), `groups missing admins: ${JSON.stringify(groups)}`);
		await s.call('authCSignIn', [alice, PW]);   // fresh sign-in → claim carries the group
		const user = await s.call('authCRequireRole', ['admins']);
		assert(user.username === alice, 'requireRole should return the user');
		s.reset();
	});

	await runTest('revokeUserSessions forces re-auth (existing session dropped)', async () => {
		await s.call('authCSignIn', [alice, PW]);
		assert((await s.call('authCCheckAuth', [])) === true, 'should be signed in');
		await s.call('authCAdminRevokeSessions', [alice]);
		// Same cookie jar — server-side session is gone, so checkAuth is false.
		assert((await s.call('authCCheckAuth', [])) === false, 'session should be revoked');
		s.reset();
	});

	await runTest('admin.disableUser blocks sign-in; enableUser restores it', async () => {
		await s.call('authCAdminDisableUser', [alice]);
		let threw = false;
		try { await s.call('authCSignIn', [alice, PW]); } catch (e: any) {
			threw = true;
			assert(e.name === 'NotAuthorizedException', `expected NotAuthorized, got ${e.name}`);
		}
		assert(threw, 'disabled user sign-in should throw');
		await s.call('authCAdminEnableUser', [alice]);
		const r = await s.call('authCSignIn', [alice, PW]);
		assert(r.status === 'signedIn', 'enabled user should sign in');
		s.reset();
	});

	await runTest('admin.deleteUser removes the user and group membership', async () => {
		await s.call('authCAdminCreateUser', [bob, PW]);
		await s.call('authCAdminSetPassword', [bob, PW]);
		await s.call('authCAdminAddToGroup', [bob, 'readers']);
		await s.call('authCAdminDeleteUser', [bob]);
		let threw = false;
		try { await s.call('authCSignIn', [bob, PW]); } catch { threw = true; }
		assert(threw, 'deleted user should not sign in');
	});

	// Cleanup
	await runTest('cleanup: delete alice', async () => {
		await s.call('authCAdminDeleteUser', [alice]);
	});

	const pass = results.filter((r) => r.status === 'pass').length;
	const fail = results.filter((r) => r.status === 'fail').length;
	console.log(`\n=== Summary: ${pass} pass · ${fail} fail (${results.length} total) ===`);
	if (fail > 0) {
		console.log('\nFailures:');
		for (const r of results.filter((r) => r.status === 'fail')) console.log(`  ✗ ${r.name}: ${r.detail}`);
	}
	process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(2);
});
