// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';

import { ALLOWED_ORIGIN_ENV_VAR, allowedOrigins, guardMutation } from './http-guards.js';

const HOST = '127.0.0.1:4400';

function req(headers: Record<string, string>): Request {
	return new Request('http://127.0.0.1:4400/api/v1/data/x/records', {
		method: 'POST',
		headers: { host: HOST, ...headers },
	});
}

describe('guardMutation — Content-Type', () => {
	it('accepts application/json', () => {
		assert.deepStrictEqual(guardMutation(req({ 'content-type': 'application/json' })), { ok: true });
	});

	it('accepts application/json with a charset parameter', () => {
		assert.deepStrictEqual(guardMutation(req({ 'content-type': 'application/json; charset=utf-8' })), { ok: true });
	});

	it('rejects the CORS-simple content types, which is the whole point', () => {
		// These three are the only types a cross-site request can send WITHOUT a
		// preflight. Refusing them is what forces an attacker's page into a
		// preflight the browser will not grant.
		for (const contentType of ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']) {
			const guard = guardMutation(req({ 'content-type': contentType }));
			assert.strictEqual(guard.ok, false, contentType);
			if (!guard.ok) assert.strictEqual(guard.status, 415);
		}
	});

	it('rejects a missing Content-Type', () => {
		const guard = guardMutation(req({}));
		assert.strictEqual(guard.ok, false);
		if (!guard.ok) assert.strictEqual(guard.status, 415);
	});
});

describe('guardMutation — Sec-Fetch-Site', () => {
	const json = { 'content-type': 'application/json' };

	it('accepts same-origin and none', () => {
		for (const site of ['same-origin', 'none']) {
			assert.deepStrictEqual(guardMutation(req({ ...json, 'sec-fetch-site': site })), { ok: true }, site);
		}
	});

	it('rejects cross-site and same-site', () => {
		for (const site of ['cross-site', 'same-site']) {
			const guard = guardMutation(req({ ...json, 'sec-fetch-site': site }));
			assert.strictEqual(guard.ok, false, site);
			if (!guard.ok) {
				assert.strictEqual(guard.status, 403);
				assert.match(guard.message, new RegExp(site));
			}
		}
	});

	it('accepts an absent header, since non-browser clients do not send it', () => {
		assert.deepStrictEqual(guardMutation(req(json)), { ok: true });
	});
});

describe('guardMutation — Origin', () => {
	const json = { 'content-type': 'application/json' };

	it('accepts our own origin', () => {
		assert.deepStrictEqual(guardMutation(req({ ...json, origin: 'http://127.0.0.1:4400' })), { ok: true });
	});

	it('accepts a loopback alias on the same port', () => {
		// The browser may have been pointed at localhost even though we bind 127.0.0.1.
		for (const origin of ['http://localhost:4400', 'http://[::1]:4400']) {
			assert.deepStrictEqual(guardMutation(req({ ...json, origin })), { ok: true }, origin);
		}
	});

	it('rejects a foreign origin', () => {
		for (const origin of ['https://evil.example', 'http://127.0.0.1:9999', 'http://localhost:3000']) {
			const guard = guardMutation(req({ ...json, origin }));
			assert.strictEqual(guard.ok, false, origin);
			if (!guard.ok) assert.strictEqual(guard.status, 403);
		}
	});

	it('rejects a malformed origin rather than parsing loosely', () => {
		const guard = guardMutation(req({ ...json, origin: 'not-a-url' }));
		assert.strictEqual(guard.ok, false);
	});

	it('accepts an absent Origin, since curl and the CLI omit it and both still need the token', () => {
		assert.deepStrictEqual(guardMutation(req(json)), { ok: true });
	});

	it('treats the opaque "null" origin as absent rather than as a host', () => {
		assert.deepStrictEqual(guardMutation(req({ ...json, origin: 'null' })), { ok: true });
	});
});

describe('guardMutation — declared origins', () => {
	const json = { 'content-type': 'application/json' };
	const TUNNEL = 'https://my-dashboard.c.tunnels.lab.aws.dev';

	/** Sets the variable for one assertion and always restores it. */
	function withAllowed<T>(value: string | undefined, body: () => T): T {
		const previous = process.env[ALLOWED_ORIGIN_ENV_VAR];
		if (value === undefined) delete process.env[ALLOWED_ORIGIN_ENV_VAR];
		else process.env[ALLOWED_ORIGIN_ENV_VAR] = value;
		try {
			return body();
		} finally {
			if (previous === undefined) delete process.env[ALLOWED_ORIGIN_ENV_VAR];
			else process.env[ALLOWED_ORIGIN_ENV_VAR] = previous;
		}
	}

	it('refuses a proxied origin until it is declared, then accepts it', () => {
		// The tunnel case: the page is served from https://<name>/ (port 443) and
		// forwarded to loopback, so Origin can never match Host and every mutating
		// request — the unlock included — was refused with no way to allow it.
		const refused = withAllowed(undefined, () => guardMutation(req({ ...json, origin: TUNNEL })));
		assert.strictEqual(refused.ok, false);
		if (!refused.ok) assert.strictEqual(refused.status, 403);

		withAllowed(TUNNEL, () => {
			assert.deepStrictEqual(guardMutation(req({ ...json, origin: TUNNEL })), { ok: true });
		});
	});

	it('accepts any one of several declared origins', () => {
		withAllowed(`https://other.example, ${TUNNEL}`, () => {
			assert.deepStrictEqual(guardMutation(req({ ...json, origin: TUNNEL })), { ok: true });
			assert.deepStrictEqual(guardMutation(req({ ...json, origin: 'https://other.example' })), { ok: true });
		});
	});

	it('still refuses an origin that was not declared', () => {
		withAllowed(TUNNEL, () => {
			const guard = guardMutation(req({ ...json, origin: 'https://evil.example' }));
			assert.strictEqual(guard.ok, false);
			if (!guard.ok) assert.strictEqual(guard.status, 403);
		});
	});

	it('matches the whole origin, so a neighbouring host or port is not covered', () => {
		// Substring or suffix matching here would hand every sibling tunnel on the
		// domain a write path into this stack.
		withAllowed(TUNNEL, () => {
			for (const origin of [
				'https://evil-my-dashboard.c.tunnels.lab.aws.dev',
				'https://my-dashboard.c.tunnels.lab.aws.dev.evil.example',
				'http://my-dashboard.c.tunnels.lab.aws.dev',
				'https://my-dashboard.c.tunnels.lab.aws.dev:8443',
			]) {
				assert.strictEqual(guardMutation(req({ ...json, origin })).ok, false, origin);
			}
		});
	});

	it('cannot be turned into a match-all', () => {
		for (const value of ['*', '', '   ', 'not-a-url', 'file:///etc/passwd']) {
			withAllowed(value, () => {
				assert.strictEqual(guardMutation(req({ ...json, origin: TUNNEL })).ok, false, value);
				assert.strictEqual(guardMutation(req({ ...json, origin: 'https://evil.example' })).ok, false, value);
			});
		}
	});

	it('does not let a declared origin excuse a cross-site request', () => {
		// Sec-Fetch-Site is checked first and on its own: a browser sets it and a
		// page cannot forge it, so a genuine cross-site attempt stays refused even
		// when its Origin names the declared one.
		withAllowed(TUNNEL, () => {
			const guard = guardMutation(req({ ...json, origin: TUNNEL, 'sec-fetch-site': 'cross-site' }));
			assert.strictEqual(guard.ok, false);
			if (!guard.ok) assert.strictEqual(guard.status, 403);
		});
	});

	it('reads the variable per request, so a later change takes effect', () => {
		withAllowed(undefined, () => {
			assert.deepStrictEqual(allowedOrigins(), []);
		});
		withAllowed(`${TUNNEL},${TUNNEL}`, () => {
			// Canonicalised and de-duplicated.
			assert.deepStrictEqual(allowedOrigins(), [TUNNEL]);
		});
	});
});

describe('guardMutation — the attack it exists to stop', () => {
	it('refuses the exact shape of a cross-site form post from another page', () => {
		// What a malicious page can send with no preflight: a simple content type,
		// its own origin, and a cross-site fetch marker.
		const guard = guardMutation(
			req({ 'content-type': 'text/plain', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }),
		);
		assert.strictEqual(guard.ok, false);
		// Content-Type is checked first, so that is the reported reason — any of
		// the three refusals is sufficient, and all three apply here.
		if (!guard.ok) assert.strictEqual(guard.status, 415);
	});

	it('refuses a JSON-typed cross-site request too, if a preflight were ever granted', () => {
		const guard = guardMutation(
			req({ 'content-type': 'application/json', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }),
		);
		assert.strictEqual(guard.ok, false);
		if (!guard.ok) assert.strictEqual(guard.status, 403);
	});
});
