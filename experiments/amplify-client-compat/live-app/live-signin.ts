// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live sign-in runner (M2). Run AFTER `cdk deploy --outputs-file`:
 *
 *   node --import ./node_modules/tsx/dist/loader.mjs \
 *     experiments/amplify-client-compat/live-app/live-signin.ts <outputs.json>
 *
 * Steps (exit 1 on the first failed MUST):
 *  1. Write amplify_outputs.json from the stack outputs (the real emitter).
 *  2. Amplify.configure(outputs) with the real aws-amplify@6 package.
 *  3. Create a confirmed throwaway user with AdminCreateUser +
 *     AdminSetUserPassword (the pool disables self sign-up, so Amplify's
 *     signUp() is refused; operator credentials, no mailbox needed).
 *  4. EXPECT: default signIn() (SRP) is rejected by the Blocks pool.
 *  5. MUST: signIn() with authFlowType USER_PASSWORD_AUTH succeeds, and the ID
 *     token's issuer is the Blocks pool.
 *  6. INFO: call the Blocks API `api.whoAmI` with the Amplify access token as a
 *     Bearer header. Records whether the BFF API recognises an Amplify-signed-in
 *     user (expected: no; input to decision 1).
 *  7. Cleanup: signOut + AdminDeleteUser (always runs).
 *
 * Needs AWS credentials for the deploy account with
 * cognito-idp:AdminCreateUser, AdminSetUserPassword and AdminDeleteUser on the pool.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Amplify } from 'aws-amplify';
import { signUp, signIn, signOut, fetchAuthSession } from 'aws-amplify/auth';
import {
	CognitoIdentityProviderClient,
	AdminCreateUserCommand,
	AdminSetUserPasswordCommand,
	AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { emitAmplifyOutputs } from '../src/emit-amplify-outputs.js';
import { writeAmplifyOutputsFile } from '../src/cdk-shim.js';

const outputsPath = process.argv[2];
if (!outputsPath) throw new Error('usage: live-signin.ts <cdk outputs.json>');
const all = JSON.parse(readFileSync(outputsPath, 'utf-8')) as Record<string, Record<string, string>>;
const stackOut = Object.values(all)[0];
if (!stackOut) throw new Error(`no stack outputs in ${outputsPath}`);
const facts = {
	region: stackOut.AmplifyRegion!,
	userPoolId: stackOut.AmplifyUserPoolId!,
	userPoolClientId: stackOut.AmplifyUserPoolClientId!,
	signInWith: ['email' as const],
};
const apiUrl = stackOut.ApiUrl;

const here = dirname(fileURLToPath(import.meta.url));
writeAmplifyOutputsFile(join(here, 'amplify_outputs.json'), facts, apiUrl);
const { outputs } = emitAmplifyOutputs(facts, { blocksApiUrl: apiUrl });
Amplify.configure(outputs);

const idp = new CognitoIdentityProviderClient({ region: facts.region });
const email = `amp-live-${randomBytes(4).toString('hex')}@example.com`;
const password = `Aa1!${randomBytes(12).toString('hex')}`;
const results: Array<[string, 'PASS' | 'FAIL' | 'INFO', string]> = [];
let failed = false;
const must = (name: string, ok: boolean, detail: string) => {
	results.push([name, ok ? 'PASS' : 'FAIL', detail]);
	if (!ok) failed = true;
	return ok;
};

try {
	// Self sign-up is disabled, so the stock signUp() must be refused.
	try {
		await signUp({ username: `x-${email}`, password, options: { userAttributes: { email: `x-${email}` } } });
		must('Amplify signUp() refused (self sign-up off)', false, 'unexpectedly accepted');
	} catch (e) {
		must('Amplify signUp() refused (self sign-up off)', true, `${(e as Error).name}: ${(e as Error).message}`);
	}
	await idp.send(
		new AdminCreateUserCommand({
			UserPoolId: facts.userPoolId,
			Username: email,
			MessageAction: 'SUPPRESS',
			UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
		}),
	);
	await idp.send(new AdminSetUserPasswordCommand({ UserPoolId: facts.userPoolId, Username: email, Password: password, Permanent: true }));
	results.push(['adminCreateUser', 'PASS', 'confirmed']);

	try {
		await signIn({ username: email, password });
		must('default signIn (SRP) rejected', false, 'unexpectedly succeeded: pool accepts SRP');
		await signOut();
	} catch (e) {
		must('default signIn (SRP) rejected', true, `${(e as Error).name}: ${(e as Error).message}`);
	}

	const inRes = await signIn({ username: email, password, options: { authFlowType: 'USER_PASSWORD_AUTH' } });
	if (must('signIn USER_PASSWORD_AUTH', inRes.isSignedIn, inRes.nextStep.signInStep)) {
		const session = await fetchAuthSession();
		const iss = String(session.tokens?.idToken?.payload.iss ?? '');
		const want = `https://cognito-idp.${facts.region}.amazonaws.com/${facts.userPoolId}`;
		must('ID token issued by the Blocks pool', iss === want, iss);

		if (apiUrl) {
			const res = await fetch(apiUrl, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${session.tokens?.accessToken.toString()}`,
				},
				body: JSON.stringify({ jsonrpc: '2.0', method: 'api.whoAmI', params: [], id: 1 }),
			});
			results.push(['Blocks API whoAmI with Amplify token', 'INFO', `HTTP ${res.status} ${await res.text()}`]);
		}
	}
} catch (e) {
	must('unexpected error', false, `${(e as Error).name}: ${(e as Error).message}`);
} finally {
	await signOut().catch(() => {});
	await idp
		.send(new AdminDeleteUserCommand({ UserPoolId: facts.userPoolId, Username: email }))
		.then(() => results.push(['cleanup AdminDeleteUser', 'PASS', email]))
		.catch((e) => results.push(['cleanup AdminDeleteUser', 'FAIL', String(e)]));
}

for (const [name, status, detail] of results) console.log(`${status.padEnd(4)} ${name} — ${detail}`);
process.exit(failed ? 1 : 0);
