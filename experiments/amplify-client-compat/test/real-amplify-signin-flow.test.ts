// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-flight for the live sign-in test (no AWS): point the REAL aws-amplify@6
 * Auth client at a local stub Cognito endpoint (127.0.0.1) and record which
 * auth flow `signIn()` asks for.
 *
 * Why it matters: Blocks' AuthCognito app client enables USER_PASSWORD_AUTH
 * and REFRESH_TOKEN_AUTH only (`userSrp: false`, bb-auth-cognito
 * index.cdk.ts). Amplify's `signIn()` defaults to USER_SRP_AUTH, which a real
 * Blocks pool rejects. So a stock Amplify app must pass
 * `options.authFlowType: 'USER_PASSWORD_AUTH'`, or Blocks must enable SRP.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Amplify } from 'aws-amplify';
import { signIn, signOut } from 'aws-amplify/auth';
import { parseAmplifyOutputs } from '@aws-amplify/core/internals/utils';
import { emitAmplifyOutputs } from '../src/emit-amplify-outputs.js';

const flows: string[] = [];
let server: Server;

before(async () => {
	server = createServer((req, res) => {
		let raw = '';
		req.on('data', (c) => (raw += c));
		req.on('end', () => {
			const target = String(req.headers['x-amz-target'] ?? '');
			if (target.endsWith('InitiateAuth')) flows.push(JSON.parse(raw).AuthFlow);
			// Answer the way a Blocks pool would for a flow it has not enabled.
			res.statusCode = 400;
			res.setHeader('content-type', 'application/x-amz-json-1.1');
			res.setHeader('x-amzn-errortype', 'InvalidParameterException');
			res.end(JSON.stringify({ __type: 'InvalidParameterException', message: 'stub: flow recorded' }));
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address() as { port: number };
	const { outputs } = emitAmplifyOutputs({
		region: 'us-west-2',
		userPoolId: 'us-west-2_ABC123',
		userPoolClientId: '1h57kf5a2b3c4d5e6f7g8h9i0j',
		signInWith: ['email'],
	});
	// Same config Amplify.configure(outputs) builds, plus a local endpoint
	// override (not expressible in amplify_outputs.json; test-only).
	const cfg = parseAmplifyOutputs(outputs);
	(cfg.Auth!.Cognito as { userPoolEndpoint?: string }).userPoolEndpoint = `http://127.0.0.1:${port}`;
	Amplify.configure(cfg);
});

after(() => server.close());

test('stock signIn() asks for USER_SRP_AUTH, which the Blocks app client does not enable', async () => {
	await assert.rejects(signIn({ username: 'user@example.com', password: 'Passw0rd!' }));
	await signOut().catch(() => {});
	// SRP starts with InitiateAuth(AuthFlow=USER_SRP_AUTH).
	assert.equal(flows.at(-1), 'USER_SRP_AUTH');
});

test("signIn() with authFlowType 'USER_PASSWORD_AUTH' asks for the flow Blocks enables", async () => {
	await assert.rejects(
		signIn({ username: 'user@example.com', password: 'Passw0rd!', options: { authFlowType: 'USER_PASSWORD_AUTH' } }),
	);
	assert.equal(flows.at(-1), 'USER_PASSWORD_AUTH');
});
