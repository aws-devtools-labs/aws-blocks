// Live check: federated ("social") sign-in for an existing Gen 2-style user
// pool through bb-auth-oidc's customOidc() provider.
//
// A real social provider (Google etc.) needs OAuth app credentials and an
// interactive login, so a second Cognito pool stands in as the upstream OIDC
// IdP. The federation path in the app pool is the same one Cognito uses for
// any OIDC social/enterprise provider: hosted UI -> upstream IdP ->
// /oauth2/idpresponse -> federated user `Social_<sub>` in the app pool.
//
// 1. Upstream pool U (the "social" IdP): hosted domain, confidential client,
//    one user.
// 2. App pool P, Gen 2-style: hosted domain, OIDC identity provider "Social"
//    -> U, and a public "gen2-client" for the code flow (what Amplify
//    `signInWithRedirect({ provider: { custom: 'Social' } })` uses).
// 3. Gen 2 path: PKCE code flow on gen2-client with identity_provider=Social,
//    in a browser; exchange the code; record P's `sub` for the federated user.
// 4. Blocks path: add a confidential "blocks-client" on P; run AuthOIDC with
//    customOidc({ issuerUrl: P }) in-process (mock runtime: same
//    OidcClientEngine as the AWS runtime, local session store). Fresh browser
//    context, sign in at U again, then handleCallback + requireAuth.
// 5. Assert the Blocks user's `sub` equals the Gen 2 `sub`, and P still has
//    exactly one user for this identity.
// 6. Delete domains and pools.
//
// No listening server: Playwright intercepts the localhost callback URLs.
//
// Run (from a scratch cwd, so .bb-data lands there):
//   AWS_REGION=us-west-2 CHROME_PATH=... node <this file>

import assert from 'node:assert';
import { randomBytes, createHash } from 'node:crypto';
import { chromium } from 'playwright';
import {
	CognitoIdentityProviderClient,
	CreateUserPoolCommand,
	CreateUserPoolClientCommand,
	CreateUserPoolDomainCommand,
	DeleteUserPoolDomainCommand,
	DeleteUserPoolCommand,
	CreateIdentityProviderCommand,
	AdminCreateUserCommand,
	AdminSetUserPasswordCommand,
	ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { Scope } from '@aws-blocks/core';
import { AuthOIDC, customOidc } from '@aws-blocks/bb-auth-oidc';

const region = process.env.AWS_REGION ?? 'us-west-2';
const cognito = new CognitoIdentityProviderClient({ region });
const suffix = randomBytes(4).toString('hex');
const upstreamEmail = `social-${suffix}@example.com`;
const upstreamPassword = `Aa1!${randomBytes(6).toString('hex')}`;
const GEN2_CALLBACK = 'http://localhost:5173/cb';
const BLOCKS_ORIGIN = 'http://localhost:3000';
const BLOCKS_CALLBACK = `${BLOCKS_ORIGIN}/aws-blocks/auth/callback`;

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`PASS ${name}`); };
const b64url = (buf) => buf.toString('base64url');
const decodeJwt = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const created = { pools: [], domains: [] }; // for teardown

async function createPool(name, extra = {}) {
	const r = await cognito.send(new CreateUserPoolCommand({
		PoolName: name,
		UsernameAttributes: ['email'],
		AutoVerifiedAttributes: ['email'],
		...extra,
	}));
	created.pools.push(r.UserPool.Id);
	return r.UserPool.Id;
}
async function createDomain(userPoolId, prefix) {
	await cognito.send(new CreateUserPoolDomainCommand({ UserPoolId: userPoolId, Domain: prefix }));
	created.domains.push({ userPoolId, prefix });
	return `https://${prefix}.auth.${region}.amazoncognito.com`;
}
async function waitForUrl(url, label) {
	let last;
	for (let i = 0; i < 120; i++) {
		const r = await fetch(url).catch((e) => ({ error: e.cause?.code ?? e.message }));
		last = r.error ?? r.status;
		if (!r.error && r.status < 500) { console.log(`  ${label} ready after ${i * 5}s (HTTP ${r.status})`); return; }
		if (i % 6 === 0) console.log(`  waiting for ${label}: ${last}`);
		await sleep(5000);
	}
	throw new Error(`${label} not reachable: ${url} (last: ${last})`);
}

/**
 * Drive the browser from `startUrl` until it hits `callbackPrefix`. Handles
 * the hosted-UI provider chooser and the upstream login form. Returns the
 * full callback URL (with code/state).
 */
async function runBrowserFlow(browser, startUrl, callbackPrefix) {
	const context = await browser.newContext();
	const page = await context.newPage();
	let callbackUrl;
	// Capture the redirect to the localhost callback from the request itself.
	// Nothing listens on localhost, so the navigation then fails harmlessly;
	// route interception doesn't see this cross-site redirect.
	page.on('request', (r) => { if (r.url().startsWith(callbackPrefix)) callbackUrl = r.url(); });
	page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log(`  -> ${f.url().slice(0, 120)}`); });
	await page.goto(startUrl).catch((e) => console.log(`  goto: ${e.message.split('\n')[0]}`));
	for (let i = 0; i < 40 && !callbackUrl; i++) {
		const chooser = page.getByRole('button', { name: /Social/ }).filter({ visible: true });
		const user = page.locator('input[name="username"]:visible');
		if (await user.count()) {
			await user.first().fill(upstreamEmail);
			await page.locator('input[name="password"]:visible').first().fill(upstreamPassword);
			await page.locator('input[name="signInSubmitButton"]:visible').first().click();
			await page.waitForLoadState().catch(() => {});
		} else if (await chooser.count()) {
			await chooser.first().click();
			await page.waitForLoadState().catch(() => {});
		}
		await sleep(1000);
	}
	if (!callbackUrl) {
		const shot = `${process.cwd()}/social-signin-stuck.png`;
		await page.screenshot({ path: shot }).catch(() => {});
		throw new Error(`browser never reached ${callbackPrefix}; last URL ${page.url()} (screenshot ${shot})`);
	}
	await context.close();
	return callbackUrl;
}

function ctx(url, cookie) {
	const headers = new Headers();
	if (cookie) headers.set('cookie', cookie);
	return {
		request: { url: new URL(url), method: 'GET', headers },
		response: { headers: new Headers(), status: 200, send() {} },
	};
}
const cookiePairs = (c) => c.response.headers.getSetCookie().map((s) => s.split(';')[0]).join('; ');

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
	// 1. Upstream "social" IdP
	const upstreamPool = await createPool(`blocks-social-test-upstream-${suffix}`);
	const upstreamIssuer = `https://cognito-idp.${region}.amazonaws.com/${upstreamPool}`;
	const upstreamDomain = await createDomain(upstreamPool, `blocks-social-up-${suffix}`);
	await cognito.send(new AdminCreateUserCommand({
		UserPoolId: upstreamPool,
		Username: upstreamEmail,
		UserAttributes: [{ Name: 'email', Value: upstreamEmail }, { Name: 'email_verified', Value: 'true' }],
		MessageAction: 'SUPPRESS',
	}));
	await cognito.send(new AdminSetUserPasswordCommand({
		UserPoolId: upstreamPool, Username: upstreamEmail, Password: upstreamPassword, Permanent: true,
	}));

	// 2. App pool (Gen 2-style) federating to the upstream IdP
	const appPool = await createPool(`blocks-social-test-app-${suffix}`, {
		Policies: { PasswordPolicy: { MinimumLength: 8, RequireLowercase: true, RequireUppercase: true, RequireNumbers: true, RequireSymbols: true } },
	});
	const appIssuer = `https://cognito-idp.${region}.amazonaws.com/${appPool}`;
	const appDomain = await createDomain(appPool, `blocks-social-app-${suffix}`);

	const upstreamClient = (await cognito.send(new CreateUserPoolClientCommand({
		UserPoolId: upstreamPool,
		ClientName: 'social-idp-client',
		GenerateSecret: true,
		AllowedOAuthFlowsUserPoolClient: true,
		AllowedOAuthFlows: ['code'],
		AllowedOAuthScopes: ['openid', 'email', 'profile'],
		CallbackURLs: [`${appDomain}/oauth2/idpresponse`],
		SupportedIdentityProviders: ['COGNITO'],
	}))).UserPoolClient;

	await cognito.send(new CreateIdentityProviderCommand({
		UserPoolId: appPool,
		ProviderName: 'Social',
		ProviderType: 'OIDC',
		ProviderDetails: {
			client_id: upstreamClient.ClientId,
			client_secret: upstreamClient.ClientSecret,
			authorize_scopes: 'openid email profile',
			oidc_issuer: upstreamIssuer,
			attributes_request_method: 'GET',
		},
		AttributeMapping: { email: 'email', email_verified: 'email_verified', username: 'sub' },
	}));

	const gen2Client = (await cognito.send(new CreateUserPoolClientCommand({
		UserPoolId: appPool,
		ClientName: 'gen2-client',
		GenerateSecret: false,
		PreventUserExistenceErrors: 'ENABLED',
		ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_CUSTOM_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
		AllowedOAuthFlowsUserPoolClient: true,
		AllowedOAuthFlows: ['code'],
		AllowedOAuthScopes: ['openid', 'email', 'profile', 'aws.cognito.signin.user.admin'],
		CallbackURLs: [GEN2_CALLBACK],
		SupportedIdentityProviders: ['Social', 'COGNITO'],
	}))).UserPoolClient;
	console.log(`upstream ${upstreamPool}, app ${appPool}`);

	await waitForUrl(`${upstreamDomain}/oauth2/authorize`, 'upstream domain');
	await waitForUrl(`${appDomain}/oauth2/authorize`, 'app domain');

	// 3. Gen 2 path: code + PKCE on gen2-client, straight to the Social IdP
	const verifier = b64url(randomBytes(32));
	const challenge = b64url(createHash('sha256').update(verifier).digest());
	const authorize = new URL(`${appDomain}/oauth2/authorize`);
	Object.entries({
		response_type: 'code',
		client_id: gen2Client.ClientId,
		redirect_uri: GEN2_CALLBACK,
		scope: 'openid email profile',
		identity_provider: 'Social',
		state: b64url(randomBytes(16)),
		code_challenge: challenge,
		code_challenge_method: 'S256',
	}).forEach(([k, v]) => authorize.searchParams.set(k, v));
	const gen2Cb = new URL(await runBrowserFlow(browser, authorize.toString(), GEN2_CALLBACK));
	const tokenResp = await fetch(`${appDomain}/oauth2/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: gen2Client.ClientId,
			code: gen2Cb.searchParams.get('code'),
			redirect_uri: GEN2_CALLBACK,
			code_verifier: verifier,
		}),
	}).then((r) => r.json());
	assert.ok(tokenResp.id_token, `token exchange failed: ${JSON.stringify(tokenResp)}`);
	const gen2Claims = decodeJwt(tokenResp.id_token);
	check('Gen 2 path: federated sign-in through the app pool issues an ID token', () => assert.strictEqual(gen2Claims.iss, appIssuer));
	console.log(`  gen2 sub ${gen2Claims.sub}, cognito:username ${gen2Claims['cognito:username']}`);

	// 4. Blocks path: bb-auth-oidc customOidc pointed at the app pool
	const blocksClient = (await cognito.send(new CreateUserPoolClientCommand({
		UserPoolId: appPool,
		ClientName: 'blocks-oidc-client',
		GenerateSecret: true,
		AllowedOAuthFlowsUserPoolClient: true,
		AllowedOAuthFlows: ['code'],
		AllowedOAuthScopes: ['openid', 'email', 'profile'],
		CallbackURLs: [BLOCKS_CALLBACK],
		SupportedIdentityProviders: ['Social'],
	}))).UserPoolClient;

	const auth = new AuthOIDC(new Scope(`social-test-${suffix}`), 'auth', {
		providers: [customOidc({
			name: 'social',
			issuerUrl: appIssuer,
			clientId: blocksClient.ClientId,
			clientSecret: blocksClient.ClientSecret,
		})],
	});
	const c1 = ctx(`${BLOCKS_ORIGIN}/aws-blocks/auth/signin/social`);
	const signInUrl = await auth.getSignInUrl(c1, 'social');
	check('Blocks: sign-in URL points at the app pool hosted UI', () => assert.ok(signInUrl.startsWith(`${appDomain}/oauth2/authorize`), signInUrl));

	const blocksCb = await runBrowserFlow(browser, signInUrl, BLOCKS_CALLBACK);
	const c2 = ctx(blocksCb, cookiePairs(c1));
	const signedIn = await auth.handleCallback(c2);
	check('Blocks: handleCallback completes and sets a session cookie', () => assert.ok(c2.response.headers.getSetCookie().length > 0));
	const user = await auth.requireAuth(ctx(`${BLOCKS_ORIGIN}/aws-blocks/api`, cookiePairs(c2)));
	console.log(`  blocks user: sub ${user.sub}, userId ${user.userId}, email ${user.email}`);

	// 5. Same identity as the Gen 2 path
	check('Blocks user.sub equals the Gen 2 federated sub', () => assert.strictEqual(user.sub, gen2Claims.sub));
	check('Blocks userId is "<app issuer>:<sub>"', () => assert.strictEqual(user.userId, `${appIssuer}:${gen2Claims.sub}`));
	check('Blocks returns the federated user email', () => assert.strictEqual(user.email, upstreamEmail));
	assert.strictEqual(signedIn.sub, user.sub);
	const users = (await cognito.send(new ListUsersCommand({ UserPoolId: appPool }))).Users;
	check('App pool holds exactly one user for this identity (no duplicate on Blocks sign-in)', () => assert.strictEqual(users.length, 1));
	console.log(`  app pool user: ${users[0].Username} (${users[0].UserStatus})`);

	console.log(`\n${pass}/7 PASS`);
} finally {
	await browser.close().catch(() => {});
	for (const d of created.domains) {
		await cognito.send(new DeleteUserPoolDomainCommand({ UserPoolId: d.userPoolId, Domain: d.prefix }))
			.catch((e) => console.log(`domain cleanup ${d.prefix}: ${e.name}`));
	}
	for (const id of created.pools) {
		await cognito.send(new DeleteUserPoolCommand({ UserPoolId: id }))
			.then(() => console.log(`deleted pool ${id}`))
			.catch((e) => console.log(`pool cleanup ${id}: ${e.name}`));
	}
}
