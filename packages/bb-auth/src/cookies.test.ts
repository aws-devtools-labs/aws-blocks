// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Cookie signing, the anchored reader, multi-cookie responses and the auto-sign-in bridge. */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { _resetConfigCache, isBlocksError, preloadConfig } from '@aws-cdk-blocks/core';
import {
	assertSessionCookieTransport,
	clearAutoSignInCookie,
	clearPendingAuthCookie,
	clearSessionCookie,
	decryptAutoSignInPayload,
	encryptAutoSignInPayload,
	readAutoSignInCookie,
	readSessionCookie,
	sessionCookieName,
	setAutoSignInCookie,
	setPendingAuthCookie,
	setSessionCookie,
	signSessionId,
	verifySessionId,
} from './cookies.js';
import { AuthErrors } from './errors.js';
import { makeContext } from './test-helpers.js';

describe('session id signing', () => {
	test('round-trips, and rejects tampering, other secrets and foreign formats', () => {
		const signed = signSessionId('abc123', 'k1');
		assert.strictEqual(verifySessionId(signed, 'k1'), 'abc123');
		assert.strictEqual(verifySessionId(signed, 'k2'), null);
		assert.strictEqual(verifySessionId(`x${signed}`, 'k1'), null);
		assert.strictEqual(verifySessionId(`${signed}x`, 'k1'), null);
		assert.strictEqual(verifySessionId('abc123', 'k1'), null, 'no signature');
		assert.strictEqual(verifySessionId('.sig', 'k1'), null, 'empty id');
		// An AuthBasic HS256 JWT: three dot-separated parts that are not our HMAC.
		assert.strictEqual(verifySessionId('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.c2ln', 'k1'), null);
	});
});

describe('readSessionCookie (anchored, escaped)', () => {
	const name = sessionCookieName('app-auth');
	test('reads the exact cookie only', () => {
		assert.strictEqual(name, 'auth_app-auth');
		assert.strictEqual(readSessionCookie(makeContext(`${name}=v1`), 'app-auth'), 'v1');
		assert.strictEqual(readSessionCookie(makeContext(`a=1; ${name}=v1; b=2`), 'app-auth'), 'v1');
		assert.strictEqual(readSessionCookie(makeContext(`a=1;${name}=v1`), 'app-auth'), 'v1');
		// A lookalike earlier in the header must not shadow the real cookie (#1253).
		assert.strictEqual(readSessionCookie(makeContext(`x${name}=evil; ${name}=v1`), 'app-auth'), 'v1');
		for (const sibling of [`my_${name}=v`, `x${name}=v`, `${name}x=v`, `${name}_old=v`]) {
			assert.strictEqual(readSessionCookie(makeContext(sibling), 'app-auth'), null, sibling);
		}
		assert.strictEqual(readSessionCookie(makeContext(`${name}=`), 'app-auth'), null, 'empty value');
		assert.strictEqual(readSessionCookie(makeContext(), 'app-auth'), null);
	});

	test('regex metacharacters in fullId are literal', () => {
		assert.strictEqual(readSessionCookie(makeContext('auth_myXapp=v'), 'my.app'), null);
		assert.strictEqual(readSessionCookie(makeContext('auth_my.app=v'), 'my.app'), 'v');
		assert.strictEqual(readSessionCookie(makeContext('auth_a+b=v'), 'a+b'), 'v');
	});
});

describe('Set-Cookie writing', () => {
	test('session set/clear keep other cookies on the same response, newest line per name wins', () => {
		const ctx = makeContext(undefined, 'app.example.com');
		clearAutoSignInCookie(ctx, 'app-auth');
		setSessionCookie(ctx, 'app-auth', 'sid.sig', 100);
		setSessionCookie(ctx, 'app-auth', 'sid2.sig', 100);
		const lines = ctx.response.headers.getSetCookie();
		assert.strictEqual(lines.length, 2);
		assert.ok(lines.some((l) => l.startsWith('autosignin_app-auth=;') && l.includes('Max-Age=0')));
		assert.ok(
			lines.some((l) => l === 'auth_app-auth=sid2.sig; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=100'),
		);
	});

	test('clear is a Max-Age=0 clearing cookie (forwarded on error responses)', () => {
		const ctx = makeContext();
		clearSessionCookie(ctx, 'app-auth');
		assert.deepStrictEqual(ctx.response.headers.getSetCookie(), [
			'auth_app-auth=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0',
		]);
	});

	test('loopback drops Secure; crossDomain uses SameSite=None; Secure; Partitioned', () => {
		const local = makeContext(undefined, 'localhost:3000');
		setSessionCookie(local, 'a', 'v.s', 1);
		assert.strictEqual(
			local.response.headers.getSetCookie()[0],
			'auth_a=v.s; HttpOnly; SameSite=Lax; Path=/; Max-Age=1',
		);
		const cross = makeContext(undefined, 'api.example.com');
		setSessionCookie(cross, 'a', 'v.s', 1, true);
		assert.match(cross.response.headers.getSetCookie()[0] ?? '', /SameSite=None; Secure; Partitioned/);
	});
});

describe('on deployed compute a loopback Origin / Host cannot drop Secure (deploy config decides)', () => {
	/** Run `fn` as on deployed compute: the two variables synth stamps, which `getDeploymentType()` reads. */
	function withDeployedEnv(fn: () => void): void {
		const keys = ['BLOCKS_CONFIG_BUCKET', 'BLOCKS_CONFIG_KEY'] as const;
		const previous = keys.map((k) => process.env[k]);
		process.env.BLOCKS_CONFIG_BUCKET = 'config-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'config.json';
		try {
			fn();
		} finally {
			keys.forEach((k, i) => {
				if (previous[i] === undefined) delete process.env[k];
				else process.env[k] = previous[i];
			});
		}
	}
	/** Every cookie this block sets and clears, on requests whose `Host` (and `Origin`, if given) is loopback. */
	function everyCookie(crossDomain: boolean, origin?: string): string[] {
		const set = makeContext(undefined, 'localhost:3000');
		const clear = makeContext(undefined, 'localhost:3000');
		if (origin) for (const ctx of [set, clear]) ctx.request.headers.set('origin', origin);
		setSessionCookie(set, 'app-auth', 'sid.sig', 100, crossDomain);
		setAutoSignInCookie(set, 'app-auth', 'bridge', 60, crossDomain);
		setPendingAuthCookie(set, 'app-auth', 'pending', 60, crossDomain);
		clearSessionCookie(clear, 'app-auth', crossDomain);
		clearAutoSignInCookie(clear, 'app-auth', crossDomain);
		clearPendingAuthCookie(clear, 'app-auth', crossDomain);
		return [...set.response.headers.getSetCookie(), ...clear.response.headers.getSetCookie()];
	}
	const loopbackOrigins = [undefined, 'http://localhost:3000', 'http://127.0.0.1:8080', 'http://[::1]:3000'];

	test('deployed: every cookie keeps Secure, and crossDomain keeps Partitioned', () => {
		withDeployedEnv(() => {
			for (const origin of loopbackOrigins) {
				const lax = everyCookie(false, origin);
				assert.strictEqual(lax.length, 6);
				for (const line of lax) assert.match(line, /; SameSite=Lax; Secure; Path=\//, `${origin}: ${line}`);
				for (const line of everyCookie(true, origin)) {
					assert.match(line, /; SameSite=None; Secure; Partitioned; Path=\//, `${origin}: ${line}`);
				}
			}
		});
	});

	test('local process: a loopback request drops Secure (the plain-HTTP dev server)', () => {
		for (const origin of loopbackOrigins) {
			for (const line of everyCookie(false, origin)) {
				assert.match(line, /; SameSite=Lax; Path=\//, `${origin}: ${line}`);
			}
		}
	});
});

describe('a front door served over plain HTTP (BLOCKS_PUBLIC_ORIGIN=http://…)', () => {
	/** Run `fn` with `BLOCKS_PUBLIC_ORIGIN` set to `origin`, then restore it. */
	function withPublicOrigin(origin: string | undefined, fn: () => void): void {
		const before = process.env.BLOCKS_PUBLIC_ORIGIN;
		if (origin === undefined) delete process.env.BLOCKS_PUBLIC_ORIGIN;
		else process.env.BLOCKS_PUBLIC_ORIGIN = origin;
		try {
			fn();
		} finally {
			if (before === undefined) delete process.env.BLOCKS_PUBLIC_ORIGIN;
			else process.env.BLOCKS_PUBLIC_ORIGIN = before;
		}
	}
	/** Async {@link withPublicOrigin}. */
	async function withPublicOriginAsync(origin: string, fn: () => Promise<void>): Promise<void> {
		const before = process.env.BLOCKS_PUBLIC_ORIGIN;
		process.env.BLOCKS_PUBLIC_ORIGIN = origin;
		try {
			await fn();
		} finally {
			if (before === undefined) delete process.env.BLOCKS_PUBLIC_ORIGIN;
			else process.env.BLOCKS_PUBLIC_ORIGIN = before;
		}
	}
	/** Run `fn` with `BLOCKS_ALLOW_PLAIN_HTTP` (the door's `allowPlainHttp` opt-out) set to `value`, then restore it. */
	function withAllowPlainHttp(value: string, fn: () => void): void {
		const before = process.env.BLOCKS_ALLOW_PLAIN_HTTP;
		process.env.BLOCKS_ALLOW_PLAIN_HTTP = value;
		try {
			fn();
		} finally {
			if (before === undefined) delete process.env.BLOCKS_ALLOW_PLAIN_HTTP;
			else process.env.BLOCKS_ALLOW_PLAIN_HTTP = before;
		}
	}
	/** Every cookie this block sets, on one non-loopback request. */
	function everyCookie(): string[] {
		const ctx = makeContext(undefined, 'app.example.com');
		setSessionCookie(ctx, 'app-auth', 'sid.sig', 100);
		setAutoSignInCookie(ctx, 'app-auth', 'bridge', 60);
		setPendingAuthCookie(ctx, 'app-auth', 'pending', 60);
		return ctx.response.headers.getSetCookie();
	}

	/** Run `fn` with `BLOCKS_DEPLOYMENT_TYPE` set to `value`, then restore it. */
	function withDeploymentType(value: string, fn: () => void): void {
		const before = process.env.BLOCKS_DEPLOYMENT_TYPE;
		process.env.BLOCKS_DEPLOYMENT_TYPE = value;
		try {
			fn();
		} finally {
			if (before === undefined) delete process.env.BLOCKS_DEPLOYMENT_TYPE;
			else process.env.BLOCKS_DEPLOYMENT_TYPE = before;
		}
	}

	test('outside a sandbox, no session cookie is issued over plain HTTP: every setter throws InsecureTransportException', () => {
		withDeploymentType('production', () =>
			withPublicOrigin('http://my-alb-123.us-east-1.elb.amazonaws.com', () => {
				const ctx = makeContext(undefined, 'app.example.com');
				const refused = (e: unknown) => isBlocksError(e, AuthErrors.InsecureTransport);
				assert.throws(() => setSessionCookie(ctx, 'app-auth', 'sid.sig', 100), refused);
				assert.throws(() => setAutoSignInCookie(ctx, 'app-auth', 'bridge', 60), refused);
				assert.throws(() => setPendingAuthCookie(ctx, 'app-auth', 'pending', 60), refused);
				assert.deepStrictEqual(ctx.response.headers.getSetCookie(), [], 'no Set-Cookie line was written');
				assert.throws(() => assertSessionCookieTransport(ctx, false), refused, 'the pre-check refuses too');
				// A clearing cookie (Max-Age=0) carries no value, so it is still written, without Secure.
				clearSessionCookie(ctx, 'app-auth');
				clearAutoSignInCookie(ctx, 'app-auth');
				clearPendingAuthCookie(ctx, 'app-auth');
				const cleared = ctx.response.headers.getSetCookie();
				assert.strictEqual(cleared.length, 3);
				for (const line of cleared) {
					assert.match(line, /=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0$/, line);
				}
				// A cross-domain cookie is set by the API's own (HTTPS) response: still issued, Secure.
				const cross = makeContext(undefined, 'api.example.com');
				setSessionCookie(cross, 'a', 'v.s', 1, true);
				assert.match(cross.response.headers.getSetCookie()[0] ?? '', /SameSite=None; Secure; Partitioned/);
			}),
		);
	});

	test("outside a sandbox, the door's `allowPlainHttp` opt-out (BLOCKS_ALLOW_PLAIN_HTTP=true) issues every cookie without Secure", () => {
		withDeploymentType('production', () =>
			withPublicOrigin('http://my-alb-123.us-east-1.elb.amazonaws.com', () => {
				withAllowPlainHttp('true', () => {
					const lines = everyCookie();
					assert.strictEqual(lines.length, 3);
					for (const line of lines) {
						assert.ok(!/;\s*Secure/.test(line), line);
						assert.match(line, /SameSite=Lax/);
					}
					assert.doesNotThrow(() => assertSessionCookieTransport(makeContext(undefined, 'app.example.com'), false));
				});
				// Any other value fails closed.
				for (const value of ['false', 'TRUE', '1', '']) {
					withAllowPlainHttp(value, () =>
						assert.throws(
							() => setSessionCookie(makeContext(undefined, 'app.example.com'), 'app-auth', 'sid.sig', 100),
							(e: unknown) => isBlocksError(e, AuthErrors.InsecureTransport),
							value,
						),
					);
				}
			}),
		);
	});

	test('on deployed compute, only the loaded config entry BLOCKS_ALLOW_PLAIN_HTTP=true opts out (an env var does not)', async (t) => {
		const keys = ['BLOCKS_CONFIG_BUCKET', 'BLOCKS_CONFIG_KEY', 'BLOCKS_DEPLOYMENT_TYPE', 'BLOCKS_ALLOW_PLAIN_HTTP'] as const;
		const previous = keys.map((k) => process.env[k]);
		const load = async (config: Record<string, string>) => {
			_resetConfigCache();
			t.mock.method(S3Client.prototype, 'send', async () => ({
				Body: { transformToString: async () => JSON.stringify(config) },
			}));
			await preloadConfig();
			t.mock.restoreAll();
		};
		const issue = () => setSessionCookie(makeContext(undefined, 'app.example.com'), 'app-auth', 'sid.sig', 100);
		const refused = (e: unknown) => isBlocksError(e, AuthErrors.InsecureTransport);
		process.env.BLOCKS_CONFIG_BUCKET = 'config-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'config.json';
		delete process.env.BLOCKS_DEPLOYMENT_TYPE;
		try {
			await withPublicOriginAsync('http://my-alb-123.us-east-1.elb.amazonaws.com', async () => {
				await load({ BLOCKS_DEPLOYMENT_TYPE: 'production', BLOCKS_ALLOW_PLAIN_HTTP: 'true' });
				assert.doesNotThrow(issue, 'the synth-time opt-out is honoured');
				await load({ BLOCKS_DEPLOYMENT_TYPE: 'production' });
				process.env.BLOCKS_ALLOW_PLAIN_HTTP = 'true';
				assert.throws(issue, refused, 'an env var on the compute cannot opt out');
				delete process.env.BLOCKS_ALLOW_PLAIN_HTTP;
				await load({ BLOCKS_DEPLOYMENT_TYPE: 'production', BLOCKS_ALLOW_PLAIN_HTTP: 'yes' });
				assert.throws(issue, refused, 'a malformed entry fails closed');
			});
		} finally {
			_resetConfigCache();
			keys.forEach((k, i) => {
				if (previous[i] === undefined) delete process.env[k];
				else process.env[k] = previous[i];
			});
		}
	});

	test('in a sandbox, every cookie drops Secure: a browser discards a Secure cookie set over HTTP (an ALB without TLS)', () => {
		withDeploymentType('sandbox', () => withPublicOrigin('http://my-alb-123.us-east-1.elb.amazonaws.com', () => {
			const lines = everyCookie();
			assert.strictEqual(lines.length, 3);
			for (const line of lines) {
				assert.ok(!/;\s*Secure/.test(line), line);
				assert.match(line, /SameSite=Lax/);
			}
			// A cross-domain cookie is set by the API's own (HTTPS) response: it keeps Secure.
			const cross = makeContext(undefined, 'api.example.com');
			setSessionCookie(cross, 'a', 'v.s', 1, true);
			assert.match(cross.response.headers.getSetCookie()[0] ?? '', /SameSite=None; Secure; Partitioned/);
		}));
	});

	test('an https:// front door, or none set, keeps Secure on every cookie', () => {
		for (const origin of ['https://app.example.com', undefined]) {
			withPublicOrigin(origin, () => {
				for (const line of everyCookie()) assert.match(line, /; Secure;/, `${origin}: ${line}`);
			});
		}
	});
});

describe('auto-sign-in bridge', () => {
	test('round-trips; tamper, wrong secret and expiry → null', () => {
		const payload = { username: 'u', password: 'p', cognitoSession: 's', exp: Date.now() + 60_000 };
		const c = encryptAutoSignInPayload(payload, 'k');
		assert.deepStrictEqual(decryptAutoSignInPayload(c, 'k'), payload);
		assert.strictEqual(decryptAutoSignInPayload(c, 'other'), null);
		assert.strictEqual(decryptAutoSignInPayload(`${c.slice(0, -2)}xx`, 'k'), null);
		assert.strictEqual(decryptAutoSignInPayload('a.b.c', 'k'), null);
		assert.strictEqual(decryptAutoSignInPayload(encryptAutoSignInPayload({ ...payload, exp: 1 }, 'k'), 'k'), null);
	});

	test('set / read / clear', () => {
		const ctx = makeContext('autosignin_app-auth=enc');
		assert.strictEqual(readAutoSignInCookie(ctx, 'app-auth'), 'enc');
		setAutoSignInCookie(ctx, 'app-auth', 'enc2', 900);
		clearAutoSignInCookie(ctx, 'app-auth');
		assert.deepStrictEqual(ctx.response.headers.getSetCookie(), [
			'autosignin_app-auth=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0',
		]);
	});
});
