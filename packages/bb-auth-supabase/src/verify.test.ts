// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createSupabaseVerifier } from './verify.js';

const AUD = 'authenticated';

describe('createSupabaseVerifier — HS256 (legacy anon/service-role era)', () => {
	const secret = 'super-secret-supabase-jwt-secret-value';
	const supabaseUrl = 'https://proj.supabase.co';
	const issuer = 'https://proj.supabase.co/auth/v1';
	const enc = new TextEncoder();

	async function mint(
		o: { secret?: string; iss?: string; aud?: string; exp?: string } = {},
	): Promise<string> {
		return new SignJWT({ email: 'alice@example.com', role: 'authenticated' })
			.setProtectedHeader({ alg: 'HS256' })
			.setIssuer(o.iss ?? issuer)
			.setAudience(o.aud ?? AUD)
			.setSubject('user-hs-123')
			.setIssuedAt()
			.setExpirationTime(o.exp ?? '2h')
			.sign(enc.encode(o.secret ?? secret));
	}

	test('verifies a valid HS256 token and returns claims', async () => {
		const verify = createSupabaseVerifier({ supabaseUrl, getSecret: async () => secret });
		const claims = await verify(await mint());
		assert.strictEqual(claims.sub, 'user-hs-123');
		assert.strictEqual(claims.email, 'alice@example.com');
		assert.strictEqual(claims.role, 'authenticated');
	});

	test('rejects a token signed with the wrong secret', async () => {
		const verify = createSupabaseVerifier({ supabaseUrl, getSecret: async () => secret });
		await assert.rejects(async () => verify(await mint({ secret: 'wrong-secret' })));
	});

	test('rejects a token with a foreign issuer', async () => {
		const verify = createSupabaseVerifier({ supabaseUrl, getSecret: async () => secret });
		await assert.rejects(async () => verify(await mint({ iss: 'https://evil.supabase.co/auth/v1' })));
	});

	test('rejects a token with the wrong audience', async () => {
		const verify = createSupabaseVerifier({ supabaseUrl, getSecret: async () => secret });
		await assert.rejects(async () => verify(await mint({ aud: 'anon' })));
	});

	test('rejects an expired token', async () => {
		const verify = createSupabaseVerifier({ supabaseUrl, getSecret: async () => secret });
		await assert.rejects(async () => verify(await mint({ exp: '-1h' })));
	});

	test('throws when an HS256 token arrives but no secret is configured', async () => {
		const verify = createSupabaseVerifier({ supabaseUrl });
		await assert.rejects(async () => verify(await mint()), /no HS256 secret/);
	});

	test('throws on a malformed token', async () => {
		const verify = createSupabaseVerifier({ supabaseUrl, getSecret: async () => secret });
		await assert.rejects(async () => verify('not-a-jwt'), /Malformed JWT/);
	});
});

describe('createSupabaseVerifier — ES256 (new asymmetric signing-key era)', () => {
	test('verifies against a served JWKS and rejects a foreign key', async () => {
		const { publicKey, privateKey } = await generateKeyPair('ES256');
		const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key-1', alg: 'ES256', use: 'sig' };

		const server = createServer((req, res) => {
			if (req.url === '/auth/v1/.well-known/jwks.json') {
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify({ keys: [jwk] }));
			} else {
				res.statusCode = 404;
				res.end('not found');
			}
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		const supabaseUrl = `http://127.0.0.1:${port}`;

		try {
			const verify = createSupabaseVerifier({ supabaseUrl });

			const token = await new SignJWT({ email: 'bob@example.com', role: 'authenticated' })
				.setProtectedHeader({ alg: 'ES256', kid: 'test-key-1' })
				.setIssuer(`${supabaseUrl}/auth/v1`)
				.setAudience(AUD)
				.setSubject('user-es-456')
				.setIssuedAt()
				.setExpirationTime('2h')
				.sign(privateKey);

			const claims = await verify(token);
			assert.strictEqual(claims.sub, 'user-es-456');
			assert.strictEqual(claims.email, 'bob@example.com');

			// A token signed by a different key (but claiming the same kid) must fail.
			const other = await generateKeyPair('ES256');
			const forged = await new SignJWT({})
				.setProtectedHeader({ alg: 'ES256', kid: 'test-key-1' })
				.setIssuer(`${supabaseUrl}/auth/v1`)
				.setAudience(AUD)
				.setSubject('attacker')
				.setIssuedAt()
				.setExpirationTime('2h')
				.sign(other.privateKey);
			await assert.rejects(async () => verify(forged));
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
