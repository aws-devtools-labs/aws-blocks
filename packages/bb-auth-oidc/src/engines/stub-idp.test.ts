// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The stub IdP's authorization codes are HMAC-signed with a key generated per
 * process. A code signed with any key published in source, including the
 * constant earlier versions used, must not be redeemable at /token.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash, createHmac } from 'node:crypto';
import type { BlocksContext } from '@aws-blocks/core';
import { handleToken } from './stub-idp.js';

const FORMER_PUBLIC_SECRET = 'blocks-stub-idp-code-signing-secret-not-for-production';

function forgeCode(payload: object, secret: string): string {
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
	return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

function tokenRequest(form: Record<string, string>): { ctx: BlocksContext; result: { status: number; body: unknown } } {
	const result = { status: 200, body: undefined as unknown };
	const ctx = {
		request: {
			url: new URL('http://localhost:3001/aws-blocks/auth/idp/google/token'),
			text: async () => new URLSearchParams(form).toString(),
			headers: new Headers(),
		},
		response: {
			headers: new Headers(),
			set status(value: number) { result.status = value; },
			get status() { return result.status; },
			send: (body: unknown) => { result.body = body; },
		},
	} as unknown as BlocksContext;
	return { ctx, result };
}

test('a code forged with the former published secret is rejected as invalid_grant', async () => {
	const verifier = 'v'.repeat(64);
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	const code = forgeCode({
		clientId: 'app',
		codeChallenge: challenge,
		codeChallengeMethod: 'S256',
		state: 's',
		nonce: 'n',
		redirectUri: 'http://localhost:3000/aws-blocks/auth/callback',
		scopes: ['openid', 'email'],
		user: { sub: 'admin', email: 'admin@example.com', name: 'Admin' },
		exp: Math.floor(Date.now() / 1000) + 300,
	}, FORMER_PUBLIC_SECRET);

	const { ctx, result } = tokenRequest({
		grant_type: 'authorization_code',
		code,
		client_id: 'app',
		redirect_uri: 'http://localhost:3000/aws-blocks/auth/callback',
		code_verifier: verifier,
	});
	await handleToken('google', ctx);

	assert.strictEqual(result.status, 400, `expected a 400, got ${result.status} ${JSON.stringify(result.body)}`);
	assert.deepStrictEqual((result.body as { error?: string }).error, 'invalid_grant');
});
