// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side regression tests for AuthOIDC's `cognitoFederated()` provider.
 *
 * History (bug #447): the CDK layer registered the federated IdP with native
 * `AWS::Cognito::UserPoolIdentityProvider` resources, writing the client
 * id/secret into `ProviderDetails` as `{{resolve:ssm-secure:...}}` dynamic
 * references. CloudFormation only allows `ssm-secure` references on a small
 * allowlist that excludes `ProviderDetails`, so `cdk synth` succeeded but every
 * deploy failed at change-set creation, leaving the stack in
 * `REVIEW_IN_PROGRESS`.
 *
 * Fix: register the IdP through a deploy-time custom resource whose handler
 * reads and decrypts the SecureString parameters via the SDK and calls
 * `CreateIdentityProvider`. The synthesized template therefore contains no
 * native IdP resource and no `ssm-secure` reference — only the parameter names.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Annotations, Template, Match } from 'aws-cdk-lib/assertions';
import { BlocksPresets, buildingBlockParent, Scope, DEFAULT_NODE_RUNTIME, registerConfig } from '@aws-blocks/core/cdk';
import { SECRETS_BULK_CONSTRUCT_ID } from '@aws-blocks/bb-app-setting';
import { AuthOIDC, cognitoFederated, google } from './index.cdk.js';
import { cognitoEnvPrefix, cookieSecretEnvVar } from './utils.js';
import type { AppSettingLike } from './providers.js';

class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly id: string;
	constructor(scope: Construct, id: string) {
		super(scope, id);
		this.id = id;
		(globalThis as any).CURRENT_BLOCKS_STACK = this;
		this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
		});
	}
}

afterEach(() => {
	delete (globalThis as any).CURRENT_BLOCKS_STACK;
});

function setup(): { stack: StubBlocksStack; parent: Scope } {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'TestStack');
	const parent = new Scope('app');
	return { stack, parent };
}

// An AppSetting-shaped stub: the CDK layer only reads `fullId`; `get()` is the
// runtime path and is never called at synth.
function appSettingStub(fullId: string): AppSettingLike {
	return { fullId, get: async () => 'unused-at-synth' };
}

function synthFederated(): Template {
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', {
		providers: [
			cognitoFederated({
				name: 'google',
				identityProvider: 'Google',
				cognitoDomain: 'myapp-abc123',
				region: 'us-east-1',
				clientId: appSettingStub('app-google-client-id'),
				clientSecret: appSettingStub('app-google-client-secret'),
			}),
		],
	});
	return Template.fromStack(stack);
}

test('CDK: cognitoFederated() emits NO native IdP resource and NO ssm-secure reference (#447)', () => {
	const template = synthFederated();
	// The bug: a native IdP resource carrying ssm-secure refs in ProviderDetails.
	template.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 0);
	// No ssm-secure dynamic reference anywhere in the synthesized template.
	const json = JSON.stringify(template.toJSON());
	assert.ok(!json.includes('{{resolve:ssm-secure'), 'template must not contain any ssm-secure dynamic reference');
	// The pool itself is still provisioned.
	template.resourceCountIs('AWS::Cognito::UserPool', 1);
});

test('CDK: cognitoFederated() registers the IdP via a custom resource that names (not embeds) the SSM params', () => {
	const template = synthFederated();
	const crs = template.findResources('AWS::CloudFormation::CustomResource');
	const idpCr = Object.values(crs).find(
		(r: any) => r.Properties?.ProviderName === 'Google' && r.Properties?.ProviderType === 'Google',
	) as any;
	assert.ok(idpCr, 'an IdP-registration custom resource should exist');
	// Only the parameter NAMES cross into the template — never the secret values.
	assert.strictEqual(idpCr.Properties.ClientIdParam, '/app-google-client-id');
	assert.strictEqual(idpCr.Properties.ClientSecretParam, '/app-google-client-secret');
	assert.strictEqual(idpCr.Properties.ProviderDetails.authorize_scopes, 'openid email profile');
});

test('CDK: the IdP custom resource depends on BlocksSecretsBulk when present (param exists before the read)', () => {
	// A real BlocksStack has bb-app-setting's shared `BlocksSecretsBulk` resource
	// (it writes every secret AppSetting's SecureString). The plain test stub does
	// not model that, so stand one in with the same construct id; AuthOIDC should
	// wire a dependency onto it so the credential parameters exist before the
	// handler reads them.
	const TOKEN = 'arn:aws:lambda:us-east-1:1:function:x';
	const { stack, parent } = setup();
	new cdk.CustomResource(stack, SECRETS_BULK_CONSTRUCT_ID, { serviceToken: TOKEN });
	new AuthOIDC(parent, 'auth', {
		providers: [
			cognitoFederated({
				name: 'google', identityProvider: 'Google', cognitoDomain: 'myapp-abc123', region: 'us-east-1',
				clientId: appSettingStub('app-google-client-id'), clientSecret: appSettingStub('app-google-client-secret'),
			}),
		],
	});
	const template = Template.fromStack(stack);
	const crs = template.findResources('AWS::CloudFormation::CustomResource');
	const bulkLogicalId = Object.keys(crs).find((k) => crs[k].Properties?.ServiceToken === TOKEN);
	assert.ok(bulkLogicalId, 'stand-in BlocksSecretsBulk should be in the template');
	const idpEntry = Object.entries(crs).find(([, r]: [string, any]) => r.Properties?.ProviderName === 'Google');
	assert.ok(idpEntry, 'IdP custom resource should exist');
	const dependsOn: string[] = (idpEntry![1] as any).DependsOn ?? [];
	assert.ok(dependsOn.includes(bulkLogicalId as string), 'IdP CR must depend on the bulk secret-init resource');
});

test('CDK: the IdP-registration Lambda is granted cognito-idp, ssm:GetParameter and scoped kms:Decrypt', () => {
	const template = synthFederated();
	// The three grants land across the role's managed statements; assert each
	// independently (kms:ViaService resolves to a region token, so match its
	// presence, not an exact string).
	template.hasResourceProperties('AWS::IAM::Policy', {
		PolicyDocument: {
			Statement: Match.arrayWith([
				Match.objectLike({ Action: Match.arrayWith(['cognito-idp:CreateIdentityProvider']) }),
			]),
		},
	});
	template.hasResourceProperties('AWS::IAM::Policy', {
		PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 'ssm:GetParameter' })]) },
	});
	template.hasResourceProperties('AWS::IAM::Policy', {
		PolicyDocument: {
			Statement: Match.arrayWith([
				Match.objectLike({
					Action: 'kms:Decrypt',
					Condition: Match.objectLike({ StringEquals: Match.objectLike({ 'kms:ViaService': Match.anyValue() }) }),
				}),
			]),
		},
	});
});

test('CDK: a self-hosted provider (google) provisions no Cognito resources', () => {
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', {
		providers: [google({ clientId: async () => 'id', clientSecret: async () => 'secret' })],
	});
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::Cognito::UserPool', 0);
	template.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 0);
});

// Pin the per-provider ProviderType + ProviderDetails so a future edit can't
// silently drift them away from what the old L2 constructs produced.
function idpProps(provider: Parameters<typeof cognitoFederated>[0]): any {
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', { providers: [cognitoFederated(provider)] });
	const crs = Template.fromStack(stack).findResources('AWS::CloudFormation::CustomResource');
	return Object.values(crs).find((r: any) => r.Properties?.ProviderType && r.Properties?.ClientIdParam) as any;
}

test('CDK: Facebook provider maps to ProviderType=Facebook, scopes "public_profile email"', () => {
	const cr = idpProps({
		name: 'fb', identityProvider: 'Facebook', cognitoDomain: 'd1', region: 'us-east-1',
		clientId: appSettingStub('fb-id'), clientSecret: appSettingStub('fb-secret'),
	});
	assert.strictEqual(cr.Properties.ProviderType, 'Facebook');
	assert.strictEqual(cr.Properties.ProviderDetails.authorize_scopes, 'public_profile email');
});

test('CDK: LoginWithAmazon provider maps to ProviderType=LoginWithAmazon, scopes "profile"', () => {
	const cr = idpProps({
		name: 'amzn', identityProvider: 'LoginWithAmazon', cognitoDomain: 'd2', region: 'us-east-1',
		clientId: appSettingStub('amzn-id'), clientSecret: appSettingStub('amzn-secret'),
	});
	assert.strictEqual(cr.Properties.ProviderType, 'LoginWithAmazon');
	assert.strictEqual(cr.Properties.ProviderDetails.authorize_scopes, 'profile');
});

test('CDK: a custom OIDC provider maps to ProviderType=OIDC with oidc_issuer + GET', () => {
	const cr = idpProps({
		name: 'corp', identityProvider: 'CorpIdP', idpIssuerUrl: 'https://idp.example.com',
		cognitoDomain: 'd3', region: 'us-east-1',
		clientId: appSettingStub('corp-id'), clientSecret: appSettingStub('corp-secret'),
	});
	assert.strictEqual(cr.Properties.ProviderType, 'OIDC');
	assert.strictEqual(cr.Properties.ProviderDetails.oidc_issuer, 'https://idp.example.com');
	assert.strictEqual(cr.Properties.ProviderDetails.attributes_request_method, 'GET');
});

test('CDK: two providers with the same identityProvider fail fast at synth', () => {
	const { parent } = setup();
	assert.throws(
		() => new AuthOIDC(parent, 'auth', {
			providers: [
				cognitoFederated({
					name: 'g1', identityProvider: 'Google', cognitoDomain: 'd', region: 'us-east-1',
					clientId: appSettingStub('g1-id'), clientSecret: appSettingStub('g1-secret'),
				}),
				cognitoFederated({
					name: 'g2', identityProvider: 'Google', cognitoDomain: 'd', region: 'us-east-1',
					clientId: appSettingStub('g2-id'), clientSecret: appSettingStub('g2-secret'),
				}),
			],
		}),
		/duplicate cognitoFederated identityProvider 'Google'/,
	);
});

// `check:api` reports the default entry only, so nothing else would catch this
// export being dropped from the CDK entry.
test('CDK: the cdk entry exports the parent helper the runtime entries use', () => {
	const self = buildingBlockParent({
		id: 'auth',
		parent: { id: 'my-app' },
		bbName: 'AuthOidc',
		bbVersion: '0.2.1',
	});

	assert.strictEqual(self.fullId, 'my-app-auth');
});

// The runtime reads these names from `process.env`; nothing fails at synth if the
// writer's name drifts, so pin the literal strings a deployed app looks up.
test('CDK: registers the exact env var names the runtime reads', () => {
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', {
		providers: [
			cognitoFederated({
				name: 'google',
				identityProvider: 'Google',
				cognitoDomain: 'myapp-abc123',
				region: 'us-east-1',
				clientId: appSettingStub('app-google-client-id'),
				clientSecret: appSettingStub('app-google-client-secret'),
			}),
		],
	});

	const registry = (stack as any)[Symbol.for('BLOCKS_CONFIG_REGISTRY')] as { entries: Map<string, unknown> } | undefined;
	assert.ok(registry, 'config registry exists on the stack');
	const keys = [...registry.entries.keys()];

	assert.ok(keys.includes('BLOCKS_AUTH_OIDC_COOKIE_SECRET_TESTSTACK_APP_AUTH'), `cookie-secret key missing: ${keys}`);
	for (const suffix of ['POOL_ID', 'CLIENT_ID', 'CLIENT_SECRET', 'REGION', 'DOMAIN']) {
		assert.ok(
			keys.includes(`BLOCKS_AUTH_OIDC_COGNITO_TESTSTACK_APP_AUTH_${suffix}`),
			`cognito ${suffix} key missing: ${keys}`,
		);
	}

	assert.strictEqual(cookieSecretEnvVar('TestStack-app-auth'), 'BLOCKS_AUTH_OIDC_COOKIE_SECRET_TESTSTACK_APP_AUTH');
	assert.strictEqual(cognitoEnvPrefix('TestStack-app-auth'), 'BLOCKS_AUTH_OIDC_COGNITO_TESTSTACK_APP_AUTH');
});

// `signInRoutePath()` is pure (derived from `callbackPath`), so it must work during
// synth, e.g. to build a link or a `RawRoute` path at module scope.
test('CDK: signInRoutePath() works during synth and follows callbackPath', () => {
	const provider = () =>
		cognitoFederated({
			name: 'google',
			identityProvider: 'Google',
			cognitoDomain: 'myapp-abc123',
			region: 'us-east-1',
			clientId: appSettingStub('app-google-client-id'),
			clientSecret: appSettingStub('app-google-client-secret'),
		});
	const { parent } = setup();
	const auth = new AuthOIDC(parent, 'auth', { providers: [provider()] });
	assert.strictEqual(auth.signInRoutePath('google'), '/aws-blocks/auth/signin/google');

	const { parent: customParent } = setup();
	const custom = new AuthOIDC(customParent, 'auth', {
		providers: [provider()],
		callbackPath: '/aws-blocks/auth/real/callback',
	});
	assert.strictEqual(custom.signInRoutePath('my provider'), '/aws-blocks/auth/real/signin/my%20provider');
});

// ── #1001: the app client registers the deployed callback / sign-out URLs ──
//
// The app client used to register only the `https://localhost` placeholder, so
// Cognito's `/oauth2/authorize` answered `redirect_mismatch` for every deployed
// app. The URLs are now resolved at synth (cdk.Lazy) from the shared gateway,
// `BLOCKS_PUBLIC_ORIGIN` (registered late, after AuthOIDC is built), sandbox
// loopback, and the caller's `additionalCallbackUrls` / `additionalLogoutUrls`.

/** A stub stack that also carries a shared REST API gateway, like a real `BlocksStack`. */
class StubGatewayStack extends StubBlocksStack {
	public readonly restApi: cdk.aws_apigateway.RestApi;
	public _sharedGateway?: { restApi: cdk.aws_apigateway.RestApi; apiUrl: string };
	constructor(scope: Construct, id: string) {
		super(scope, id);
		this.restApi = new cdk.aws_apigateway.RestApi(this, 'SharedApi');
		this.restApi.root.addMethod('ANY', new cdk.aws_apigateway.MockIntegration());
	}
}

function federatedProvider(extra: { additionalCallbackUrls?: string[]; additionalLogoutUrls?: string[] } = {}) {
	return cognitoFederated({
		name: 'google',
		identityProvider: 'Google',
		cognitoDomain: 'myapp-abc123',
		region: 'us-east-1',
		clientId: appSettingStub('app-google-client-id'),
		clientSecret: appSettingStub('app-google-client-secret'),
		...extra,
	});
}

interface ClientUrls {
	callbackUrls: unknown[];
	logoutUrls: unknown[];
}

function clientUrls(template: Template): ClientUrls {
	const clients = Object.values(template.findResources('AWS::Cognito::UserPoolClient'));
	assert.strictEqual(clients.length, 1, 'exactly one app client');
	const props = (clients[0] as { Properties: { CallbackURLs: unknown[]; LogoutURLs: unknown[] } }).Properties;
	return { callbackUrls: props.CallbackURLs, logoutUrls: props.LogoutURLs };
}

test('CDK (#1001): the app client registers BLOCKS_PUBLIC_ORIGIN registered AFTER AuthOIDC was built', () => {
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', { providers: [federatedProvider()] });
	// Registered late, as Hosting / the managed CloudFront front door do.
	registerConfig(stack, 'BLOCKS_PUBLIC_ORIGIN', 'https://d111111abcdef8.cloudfront.net');
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
		CallbackURLs: Match.arrayWith(['https://d111111abcdef8.cloudfront.net/aws-blocks/auth/callback']),
		LogoutURLs: Match.arrayWith(['https://d111111abcdef8.cloudfront.net/']),
	});
	const { callbackUrls, logoutUrls } = clientUrls(template);
	assert.ok(!callbackUrls.includes('https://localhost/aws-blocks/auth/callback'), 'placeholder must not be registered');
	assert.ok(!logoutUrls.includes('https://localhost/'), 'placeholder must not be registered');
});

test('CDK (#1001): the app client registers the shared API Gateway URL + callback path (no double slash)', () => {
	const app = new cdk.App();
	const stack = new StubGatewayStack(app, 'TestStack');
	const parent = new Scope('app');
	new AuthOIDC(parent, 'auth', { providers: [federatedProvider()] });
	// The gateway is built after the backend module (and so AuthOIDC) — attach it late.
	stack._sharedGateway = { restApi: stack.restApi, apiUrl: `${stack.restApi.url}aws-blocks/api` };
	const template = Template.fromStack(stack);
	const { callbackUrls, logoutUrls } = clientUrls(template);
	// No public origin and no sandbox: only the gateway entry, a Fn::Join of the
	// execute-api URL (which ends in `/`) and the path without its leading `/`.
	assert.strictEqual(callbackUrls.length, 1);
	const callbackJson = JSON.stringify(callbackUrls[0]);
	assert.ok(callbackJson.includes('execute-api'), `expected the execute-api URL, got ${callbackJson}`);
	assert.ok(callbackJson.includes('/aws-blocks/auth/callback') || callbackJson.includes('"aws-blocks/auth/callback'));
	assert.ok(!callbackJson.includes('//aws-blocks'), 'no double slash between stage and path');
	assert.ok(!callbackJson.includes('localhost'), 'no localhost placeholder once a gateway exists');
	assert.strictEqual(logoutUrls.length, 1);
	assert.ok(JSON.stringify(logoutUrls[0]).includes('execute-api'));
});

test('CDK (#1001): additionalCallbackUrls / additionalLogoutUrls are merged and de-duplicated', () => {
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', {
		providers: [
			federatedProvider({
				additionalCallbackUrls: [
					'https://app.example.com/login/done',
					'myapp://auth/callback',
					'https://d111111abcdef8.cloudfront.net/aws-blocks/auth/callback',
				],
				additionalLogoutUrls: ['https://app.example.com/', 'myapp://signed-out'],
			}),
		],
	});
	registerConfig(stack, 'BLOCKS_PUBLIC_ORIGIN', 'https://d111111abcdef8.cloudfront.net');
	const { callbackUrls, logoutUrls } = clientUrls(Template.fromStack(stack));
	assert.deepStrictEqual(callbackUrls, [
		'https://d111111abcdef8.cloudfront.net/aws-blocks/auth/callback',
		'https://app.example.com/login/done',
		'myapp://auth/callback',
	]);
	assert.deepStrictEqual(logoutUrls, [
		'https://d111111abcdef8.cloudfront.net/',
		'https://app.example.com/',
		'myapp://signed-out',
	]);
});

test('CDK (#1001): sandbox mode also registers the http://localhost:3000 loopback origin', () => {
	const app = new cdk.App({ context: { sandboxMode: 'true' } });
	const stack = new StubBlocksStack(app, 'TestStack');
	const parent = new Scope('app');
	new AuthOIDC(parent, 'auth', { providers: [federatedProvider()] });
	const { callbackUrls, logoutUrls } = clientUrls(Template.fromStack(stack));
	assert.deepStrictEqual(callbackUrls, ['http://localhost:3000/aws-blocks/auth/callback']);
	assert.deepStrictEqual(logoutUrls, ['http://localhost:3000/']);
});

test('CDK (#1001): outside sandbox mode no localhost loopback origin is registered', () => {
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', { providers: [federatedProvider()] });
	registerConfig(stack, 'BLOCKS_PUBLIC_ORIGIN', 'https://app.example.com');
	const { callbackUrls } = clientUrls(Template.fromStack(stack));
	assert.deepStrictEqual(callbackUrls, ['https://app.example.com/aws-blocks/auth/callback']);
});

test('CDK (#1001): a custom callbackPath is used for every derived callback URL', () => {
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', { providers: [federatedProvider()], callbackPath: '/aws-blocks/auth/real/callback' });
	registerConfig(stack, 'BLOCKS_PUBLIC_ORIGIN', 'https://app.example.com');
	const { callbackUrls } = clientUrls(Template.fromStack(stack));
	assert.deepStrictEqual(callbackUrls, ['https://app.example.com/aws-blocks/auth/real/callback']);
});

test('CDK (#1001): a plain-http public origin (ALB without a certificate) is not registered', () => {
	// Cognito rejects non-localhost http:// callback URLs, which would fail the deploy.
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', { providers: [federatedProvider()] });
	registerConfig(stack, 'BLOCKS_PUBLIC_ORIGIN', 'http://my-alb-123.us-east-1.elb.amazonaws.com');
	const { callbackUrls } = clientUrls(Template.fromStack(stack));

	const hasHttpElbOrigin = callbackUrls
		.filter((value): value is string => typeof value === 'string')
		.some((value) => {
			try {
				const parsed = new URL(value);
				return parsed.protocol === 'http:' &&
					(parsed.hostname === 'elb.amazonaws.com' || parsed.hostname.endsWith('.elb.amazonaws.com'));
			} catch {
				return false;
			}
		});

	assert.ok(!hasHttpElbOrigin, 'http ELB origin must not be registered');
});

test('CDK (#1001): a branded backend root with a shared gateway AND an https BLOCKS_PUBLIC_ORIGIN registers exactly both', () => {
	// The real deployed shape: Hosting / the front door publishes an https origin
	// AND the shared API Gateway exists. The stub carries the same backend-root
	// brand `BlocksStack` / `BlocksBackend` set (`Symbol.for('blocks:BackendRoot')`),
	// and the ambient CURRENT_BLOCKS_STACK is cleared before synth, so the Lazy
	// producers find the gateway and the origin via the branded tree walk, not
	// the ambient fallback.
	const app = new cdk.App();
	const stack = new StubGatewayStack(app, 'TestStack');
	// A branded root is read for its `defaults` too (Scope.defaults walks to it).
	Object.assign(stack, { defaults: BlocksPresets.production });
	(stack as unknown as Record<symbol, unknown>)[Symbol.for('blocks:BackendRoot')] = true;
	const parent = new Scope('app');
	new AuthOIDC(parent, 'auth', { providers: [federatedProvider()] });
	stack._sharedGateway = { restApi: stack.restApi, apiUrl: `${stack.restApi.url}aws-blocks/api` };
	registerConfig(stack, 'BLOCKS_PUBLIC_ORIGIN', 'https://d111111abcdef8.cloudfront.net');
	delete (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK;

	const { callbackUrls } = clientUrls(Template.fromStack(stack));
	assert.strictEqual(callbackUrls.length, 2, `expected origin + gateway, got ${JSON.stringify(callbackUrls)}`);
	// Origin first (it is what the runtime sends whenever it is published), then the gateway.
	assert.strictEqual(callbackUrls[0], 'https://d111111abcdef8.cloudfront.net/aws-blocks/auth/callback');
	const gateway = callbackUrls[1] as { 'Fn::Join'?: [string, unknown[]] };
	assert.ok(gateway['Fn::Join'], `gateway entry should be an Fn::Join, got ${JSON.stringify(gateway)}`);
	const parts = gateway['Fn::Join'][1];
	const last = parts[parts.length - 1];
	assert.ok(
		typeof last === 'string' && last.endsWith('/aws-blocks/auth/callback'),
		`final literal part should end with /aws-blocks/auth/callback, got ${JSON.stringify(last)}`,
	);
});

test('CDK (#1001): a plain-http public origin emits the PlainHttpPublicOrigin synth warning (not an error)', () => {
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', { providers: [federatedProvider()] });
	registerConfig(stack, 'BLOCKS_PUBLIC_ORIGIN', 'http://my-alb-123.us-east-1.elb.amazonaws.com');
	const template = Template.fromStack(stack);
	const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('PlainHttpPublicOrigin'));
	assert.strictEqual(warnings.length, 1, 'exactly one PlainHttpPublicOrigin warning');
	assert.match(String(warnings[0].entry.data), /redirect_mismatch/);
	assert.strictEqual(clientUrls(template).callbackUrls.length, 1, 'still synthesizes with a fallback entry');
});

test('CDK (#1001): an https public origin emits no PlainHttpPublicOrigin warning', () => {
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', { providers: [federatedProvider()] });
	registerConfig(stack, 'BLOCKS_PUBLIC_ORIGIN', 'https://app.example.com');
	Template.fromStack(stack);
	const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('PlainHttpPublicOrigin'));
	assert.strictEqual(warnings.length, 0);
});

test('CDK (#1001): additionalCallbackUrls / additionalLogoutUrls reject non-localhost http and fragments at synth', () => {
	const build = (extra: { additionalCallbackUrls?: string[]; additionalLogoutUrls?: string[] }) => {
		const { parent } = setup();
		new AuthOIDC(parent, 'auth', { providers: [federatedProvider(extra)] });
	};
	assert.throws(
		() => build({ additionalCallbackUrls: ['http://app.example.com/cb'] }),
		/additionalCallbackUrls: 'http:\/\/app\.example\.com\/cb' uses http/,
	);
	assert.throws(() => build({ additionalLogoutUrls: ['https://app.example.com/#done'] }), /additionalLogoutUrls: .*fragment/);
	assert.throws(() => build({ additionalCallbackUrls: ['not a url'] }), /'not a url' is not a valid URL/);
	// Accepted: localhost over http, https, and native custom schemes.
	build({
		additionalCallbackUrls: ['http://localhost:5173/aws-blocks/auth/callback', 'https://a.example.com/cb', 'myapp://auth/callback'],
		additionalLogoutUrls: ['http://localhost:5173/'],
	});
});

// --- classifyPublicOrigin: every scheme branch has a positive AND a negative case,
// so defeating any single scheme check flips one of these assertions.

/** The fallback entries the client gets when nothing else is registered. */
const FALLBACK_CALLBACK = 'https://localhost/aws-blocks/auth/callback';

function plainHttpWarnings(stack: cdk.Stack) {
	return Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('PlainHttpPublicOrigin'));
}

test('CDK (#1001): a plain-http literal origin is skipped (only the fallback is registered) and warns', () => {
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', { providers: [federatedProvider()] });
	registerConfig(stack, 'BLOCKS_PUBLIC_ORIGIN', 'http://my-alb-123.us-east-1.elb.amazonaws.com');
	const { callbackUrls, logoutUrls } = clientUrls(Template.fromStack(stack));
	assert.deepStrictEqual(callbackUrls, [FALLBACK_CALLBACK]);
	assert.deepStrictEqual(logoutUrls, ['https://localhost/']);
	const warnings = plainHttpWarnings(stack);
	assert.strictEqual(warnings.length, 1);
	assert.match(String(warnings[0].entry.data), /my-alb-123\.us-east-1\.elb\.amazonaws\.com/);
});

test('CDK (#1001): an http:// origin with a deploy-time token host (certless ALB door) is skipped and warns', () => {
	// `http://${Token}`: the scheme is a literal, the host only resolves at deploy.
	// Without the literal-scheme check this would fall through to "register as-is".
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', { providers: [federatedProvider()] });
	const albDns = cdk.Fn.importValue('AlbDnsName');
	registerConfig(stack, 'BLOCKS_PUBLIC_ORIGIN', `http://${albDns}`);
	const { callbackUrls, logoutUrls } = clientUrls(Template.fromStack(stack));
	assert.deepStrictEqual(callbackUrls, [FALLBACK_CALLBACK], 'the http door must not be registered');
	assert.deepStrictEqual(logoutUrls, ['https://localhost/']);
	assert.ok(!JSON.stringify(callbackUrls).includes('AlbDnsName'));
	assert.strictEqual(plainHttpWarnings(stack).length, 1, 'exactly one PlainHttpPublicOrigin warning');
});

test('CDK (#1001): a whole-token origin that resolves at synth to https is registered (no warning)', () => {
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', { providers: [federatedProvider()] });
	registerConfig(stack, 'BLOCKS_PUBLIC_ORIGIN', cdk.Lazy.string({ produce: () => 'https://byo.example.com' }));
	const { callbackUrls, logoutUrls } = clientUrls(Template.fromStack(stack));
	assert.deepStrictEqual(callbackUrls, ['https://byo.example.com/aws-blocks/auth/callback']);
	assert.deepStrictEqual(logoutUrls, ['https://byo.example.com/']);
	assert.strictEqual(plainHttpWarnings(stack).length, 0);
});

test('CDK (#1001): a whole-token origin that resolves at synth to http is skipped and warns', () => {
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', { providers: [federatedProvider()] });
	registerConfig(stack, 'BLOCKS_PUBLIC_ORIGIN', cdk.Lazy.string({ produce: () => 'http://byo-alb.example.com' }));
	const { callbackUrls } = clientUrls(Template.fromStack(stack));
	assert.deepStrictEqual(callbackUrls, [FALLBACK_CALLBACK], 'the resolved http origin must not be registered');
	const warnings = plainHttpWarnings(stack);
	assert.strictEqual(warnings.length, 1);
	assert.match(String(warnings[0].entry.data), /byo-alb\.example\.com/);
});

test('CDK (#1001): a whole-token origin that only resolves at deploy is deliberately registered as-is', () => {
	const { stack, parent } = setup();
	new AuthOIDC(parent, 'auth', { providers: [federatedProvider()] });
	registerConfig(stack, 'BLOCKS_PUBLIC_ORIGIN', cdk.Fn.importValue('BrandedOrigin'));
	const { callbackUrls } = clientUrls(Template.fromStack(stack));
	assert.strictEqual(callbackUrls.length, 1);
	const json = JSON.stringify(callbackUrls[0]);
	assert.ok(json.includes('BrandedOrigin'), `expected the imported origin, got ${json}`);
	assert.ok(json.includes('aws-blocks/auth/callback'));
	assert.strictEqual(plainHttpWarnings(stack).length, 0);
});

// --- assertCognitoClientUrl: the RAW string is what gets registered, so it is validated as written.

test('CDK (#1001): additionalCallbackUrls / additionalLogoutUrls reject malformed or unsafe entries at synth', () => {
	const build = (extra: { additionalCallbackUrls?: string[]; additionalLogoutUrls?: string[] }) => {
		const { parent } = setup();
		new AuthOIDC(parent, 'auth', { providers: [federatedProvider(extra)] });
	};
	const rejects = (url: string, pattern: RegExp, option: 'additionalCallbackUrls' | 'additionalLogoutUrls' = 'additionalCallbackUrls') => {
		assert.throws(
			() => build({ [option]: [url] }),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				// Names the provider, the option and the offending URL.
				assert.ok(err.message.includes(`cognitoFederated('Google') option ${option}`), err.message);
				assert.ok(err.message.includes(`'${url}'`), err.message);
				assert.match(err.message, pattern);
				return true;
			},
			`expected ${JSON.stringify(url)} to be rejected`,
		);
	};
	rejects('javascript:alert(1)', /'javascript:' scheme/);
	rejects('data:text/html,hi', /'data:' scheme/);
	rejects('file:///etc/hosts', /'file:' scheme/, 'additionalLogoutUrls');
	rejects('https://user@app.example.com/cb', /userinfo/);
	rejects('https://app.example.com\\@other.example/cb', /backslash/);
	rejects('https:///nohost/cb', /has no host/);
	rejects(' https://app.example.com/cb', /whitespace or control characters/);
	rejects('https://app.example.com/cb ', /whitespace or control characters/);
	rejects('https://app.example.com/\tcb', /whitespace or control characters/);
	rejects('https://*.example.com/cb', /wildcard host/);
	rejects('https://exämple.com/cb', /non-ASCII host/);
	rejects('https://app.example.com/cb?code=abc', /reserved OAuth query parameter\(s\) 'code'/);
	rejects('https://app.example.com/cb?x=1&state=s', /'state'/, 'additionalLogoutUrls');
	rejects('nope', /no scheme/);
	// Accepted: https, http on localhost, a punycode host, a non-reserved query, native custom schemes.
	build({
		additionalCallbackUrls: [
			'https://app.example.com/cb',
			'https://xn--exmple-cua.com/cb',
			'https://app.example.com/cb?tenant=a',
			'myapp://auth/callback',
			'com.example.app:/oauth2redirect',
		],
		additionalLogoutUrls: ['http://localhost:5173/', 'myapp://signed-out'],
	});
	// Unresolved tokens are skipped (their value isn't known at synth).
	build({ additionalCallbackUrls: [cdk.Fn.importValue('ExtraCallback')] });
});
