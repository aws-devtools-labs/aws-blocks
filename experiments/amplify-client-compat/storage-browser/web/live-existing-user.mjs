// Live check: does a user created through an Amplify Gen 2-style app client
// sign in through the app client Blocks adds when wrapping that pool with
// AuthCognito.fromExisting()?
//
// 1. Create a throwaway pool + app client mirroring Amplify Gen 2 defaults
//    (email as username, SRP + custom + refresh flows, no secret).
// 2. Create the user the Gen 2 way: stock Amplify `signUp` on that client,
//    admin-confirm, then stock Amplify `signIn` (SRP) to capture its `sub`.
// 3. Add a second client with exactly the settings bb-auth-cognito's CDK
//    construct uses (USER_PASSWORD_AUTH + refresh, no SRP, no OAuth).
// 4. Sign in with the Blocks AuthCognito runtime on that client and check the
//    session cookie resolves to the same `sub`. Then check wrong password is
//    rejected and the Gen 2 client still signs the user in.
// 5. Delete the pool (and so its clients and user).
//
// Run: AWS_REGION=us-west-2 node web/live-existing-user.mjs

import assert from 'node:assert';
import {
	CognitoIdentityProviderClient,
	CreateUserPoolCommand,
	CreateUserPoolClientCommand,
	AdminConfirmSignUpCommand,
	DeleteUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { Amplify } from 'aws-amplify';
import { signUp, signIn, signOut, fetchAuthSession } from 'aws-amplify/auth';
import { Scope } from '@aws-blocks/core';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { AuthCognito } from '@aws-blocks/bb-auth-cognito';

// Same as bb-auth-cognito's internal envVarNames() (src/types.ts), which isn't exported.
const envVarNames = (fullId) => {
	const upper = fullId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
	return {
		USER_POOL_ID: `BLOCKS_AUTH_COGNITO_${upper}_USER_POOL_ID`,
		CLIENT_ID: `BLOCKS_AUTH_COGNITO_${upper}_CLIENT_ID`,
		REGION: `BLOCKS_AUTH_COGNITO_${upper}_REGION`,
	};
};

const region = process.env.AWS_REGION ?? 'us-west-2';
const cognito = new CognitoIdentityProviderClient({ region });
const suffix = Math.random().toString(36).slice(2, 8);
const email = `existing-${suffix}@example.com`;
const password = `Aa1!${Math.random().toString(36).slice(2, 12)}`;

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`PASS ${name}`); };

const ctx = () => ({ request: { headers: new Headers() }, response: { headers: new Headers() } });
const roll = (prev) => {
	const next = ctx();
	const raw = prev.response.headers.get('set-cookie');
	if (raw) next.request.headers.set('cookie', raw.split(';')[0]);
	return next;
};

let userPoolId;
let sessionTable;
const ddb = new DynamoDBClient({ region });
try {
	// 1. Gen 2-style pool and client
	const pool = await cognito.send(new CreateUserPoolCommand({
		PoolName: `blocks-existing-user-test-${suffix}`,
		UsernameAttributes: ['email'],
		AutoVerifiedAttributes: ['email'],
		Policies: { PasswordPolicy: { MinimumLength: 8, RequireLowercase: true, RequireUppercase: true, RequireNumbers: true, RequireSymbols: true } },
		AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
	}));
	userPoolId = pool.UserPool.Id;
	const gen2Client = await cognito.send(new CreateUserPoolClientCommand({
		UserPoolId: userPoolId,
		ClientName: 'gen2-client',
		GenerateSecret: false,
		PreventUserExistenceErrors: 'ENABLED',
		ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_CUSTOM_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
	}));
	const gen2ClientId = gen2Client.UserPoolClient.ClientId;
	console.log(`pool ${userPoolId}, gen2 client ${gen2ClientId}`);

	// 2. Existing user, created and signed in with stock Amplify (SRP)
	Amplify.configure({ Auth: { Cognito: { userPoolId, userPoolClientId: gen2ClientId } } });
	await signUp({ username: email, password, options: { userAttributes: { email } } });
	await cognito.send(new AdminConfirmSignUpCommand({ UserPoolId: userPoolId, Username: email }));
	const amp = await signIn({ username: email, password });
	check('Amplify SRP sign-in on the Gen 2 client', () => assert.strictEqual(amp.isSignedIn, true));
	const gen2Sub = (await fetchAuthSession()).tokens.idToken.payload.sub;
	await signOut();

	// 3. Blocks' own app client, same settings as bb-auth-cognito's CDK construct
	const blocksClient = await cognito.send(new CreateUserPoolClientCommand({
		UserPoolId: userPoolId,
		ClientName: 'blocks-client',
		GenerateSecret: false,
		PreventUserExistenceErrors: 'ENABLED',
		ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
	}));
	const blocksClientId = blocksClient.UserPoolClient.ClientId;

	// 4. Blocks AuthCognito runtime on the existing pool
	// Same wiring as the package's own sandbox tests (scenarios.sandbox.test.ts),
	// except the env vars a deployed Lambda would get are set BEFORE
	// construction, because the constructor builds its Cognito SDK client and
	// registers SDK identifiers from them. A probe instance yields the fullId.
	const blockId = `auth${suffix}`;
	const env = envVarNames(new AuthCognito(new Scope('existing-user'), blockId, {}).fullId);
	process.env[env.USER_POOL_ID] = userPoolId;
	process.env[env.CLIENT_ID] = blocksClientId;
	process.env[env.REGION] = region;
	const blocks = new AuthCognito(new Scope('existing-user'), blockId, {});
	// Session secret normally comes from AppSetting.
	blocks.sessionSecret = 'existing-user-test-secret-not-production';
	// AuthCognito keeps its session records in a nested KVStore (DynamoDB,
	// key `pk`). In a deployed app its CDK construct creates that table; here
	// the script creates a throwaway one with the name the KVStore registered.
	// KVStore table name defaults to its fullId (bb-kv-store index.aws.js).
	sessionTable = blocks.sessions.kv.fullId.substring(0, 255);
	await ddb.send(new CreateTableCommand({
		TableName: sessionTable,
		BillingMode: 'PAY_PER_REQUEST',
		AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
		KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
	}));
	await waitUntilTableExists({ client: ddb, maxWaitTime: 120 }, { TableName: sessionTable });

	const c1 = ctx();
	const r = await blocks.signIn(email, password, c1);
	check('Blocks signIn on the Blocks client returns signedIn', () => assert.strictEqual(r.status, 'signedIn'));
	check('Blocks signIn sets a session cookie', () => assert.ok(c1.response.headers.get('set-cookie')));
	const user = await blocks.requireAuth(roll(c1));
	check('Blocks session resolves to the same sub as the Gen 2 sign-in', () => assert.strictEqual(user.userSub, gen2Sub));

	let wrong;
	try { await blocks.signIn(email, `${password}x`, ctx()); } catch (e) { wrong = e; }
	check('Blocks signIn rejects a wrong password', () => assert.ok(wrong, 'expected an error'));
	console.log(`  wrong-password error: ${wrong?.name ?? ''} ${wrong?.message ?? ''}`.trimEnd());

	const amp2 = await signIn({ username: email, password });
	check('Gen 2 client still signs the user in after the Blocks client is added', () => assert.strictEqual(amp2.isSignedIn, true));
	await signOut();

	console.log(`\n${pass}/6 PASS`);
} finally {
	if (sessionTable) {
		await ddb.send(new DeleteTableCommand({ TableName: sessionTable })).catch((e) => console.log(`table cleanup: ${e.name}`));
		console.log(`deleted table ${sessionTable}`);
	}
	if (userPoolId) {
		await cognito.send(new DeleteUserPoolCommand({ UserPoolId: userPoolId }));
		console.log(`deleted pool ${userPoolId}`);
	}
}
