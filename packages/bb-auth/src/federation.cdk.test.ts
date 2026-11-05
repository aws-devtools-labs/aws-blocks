// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hosted-UI federation infrastructure (D3b): what `Auth` provisions for social,
 * SAML and Cognito-federated OIDC providers (`type: 'oidc'` on the default
 * `store: 'cognito'`), and — just as important — that it provisions nothing new
 * otherwise (including for a `store: 'builtin'` block).
 *
 * Template tests synth under `--conditions=cdk` (see `test-support/cdk-synth.ts`);
 * the synth-time checks run in process, like `index.cdk.test.ts`.
 *
 * The default template's byte-identity with `AuthCognito` is proven by
 * `resource-identity.cdk.test.ts` (B1's fixture) and
 * `property-snapshot.cdk.test.ts` (D3a's snapshot), both unchanged by D3b.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { ScopeParent } from '@aws-blocks/core';
import { BLOCKS_AUTH_PREFIX } from '@aws-blocks/core';
import * as cdk from 'aws-cdk-lib';
import {
	AUTH_ROUTE_PREFIX,
	cognitoFederatedProviders,
	cognitoProviderName,
	DEFAULT_CALLBACK_PATH,
	DEFAULT_SIGNOUT_PATH,
	federationConfigKeys,
} from './cdk/contract.js';
import { deriveDomainPrefix } from './cdk/federation.js';
import { DOMAIN_PREFIX_PATTERN, RESERVED_DOMAIN_WORDS } from './cdk/federation-providers.js';
import { Auth } from './index.cdk.js';
import {
	type CdkSynthResult,
	type CfnResourceJson,
	type CfnTemplateJson,
	HARNESS_API_URL,
	synthUnderCdkConditions,
} from './test-support/cdk-synth.js';
import type { AuthOptions } from './types.js';

// ── Synth harness ────────────────────────────────────────────────────────────

/** Real `secret: true` AppSettings, declared before `Auth` as an app would. */
const SECRETS = `
const googleSecret = new AppSetting(stack, 'google-secret', { secret: true });
const facebookSecret = new AppSetting(stack, 'facebook-secret', { secret: true });
const amazonSecret = new AppSetting(stack, 'amazon-secret', { secret: true });
const appleKey = new AppSetting(stack, 'apple-key', { secret: true });
const oktaSecret = new AppSetting(stack, 'okta-secret', { secret: true });
`;

const P = {
	google: "google: { type: 'google', clientId: 'g-client', clientSecret: googleSecret }",
	facebook: "facebook: { type: 'facebook', clientId: 'fb-app', clientSecret: facebookSecret }",
	amazon: "amazon: { type: 'amazon', clientId: 'amzn1.application-oa2-client.x', clientSecret: amazonSecret }",
	apple: "apple: { type: 'apple', clientId: 'com.example.web', teamId: 'TEAM123', keyId: 'KEY456', privateKey: appleKey }",
	oktaDirect: "okta: { type: 'oidc', issuer: 'https://dev-1.okta.com', clientId: '0oa1' }",
	oktaCognito: "okta: { type: 'oidc', issuer: 'https://dev-1.okta.com', clientId: '0oa1', clientSecret: oktaSecret }",
	corpUrl: "corp: { type: 'saml', metadataUrl: 'https://idp.example.com/metadata' }",
} as const;

const CONFIGS = {
	default: "new Auth(stack, 'auth')",
	directOnly: `new Auth(stack, 'auth', { store: 'builtin', providers: { ${P.oktaDirect} } })`,
	socialOnly: `new Auth(stack, 'auth', { emailPassword: false, providers: { ${P.google} } })`,
	samlOnly: `new Auth(stack, 'auth', { emailPassword: false, providers: { ${P.corpUrl} } })`,
	cognitoOidcOnly: `new Auth(stack, 'auth', { emailPassword: false, providers: { ${P.oktaCognito} } })`,
	// Password + social + SAML in `auth`; the directly federated okta can no longer share it, so it gets its own
	// `store: 'builtin'` block, built first (the comma expression keeps `auth` the block under test).
	mixed: `(new Auth(stack, 'sso', { store: 'builtin', providers: { ${P.oktaDirect} } }), new Auth(stack, 'auth', { providers: { ${P.google}, ${P.apple}, ${P.corpUrl} } }))`,
	allSocial: `new Auth(stack, 'auth', { providers: { ${P.google}, ${P.facebook}, ${P.amazon}, ${P.apple} } })`,
	defaultPlusGoogle: `new Auth(stack, 'auth', { providers: { ${P.google} } })`,
} as const;

interface SynthOptions {
	/** Lines run after `Auth` is built (e.g. a Hosting-style `registerConfig`). */
	after?: string;
	/** Lines run before `Auth` is built. */
	before?: string;
	/** Passed to the harness (`null` = no compute). */
	apiUrl?: string | null;
}

const cache = new Map<string, CdkSynthResult>();
function synth(construct: string, options: SynthOptions = {}): CdkSynthResult {
	const key = JSON.stringify([construct, options]);
	const hit = cache.get(key);
	if (hit) return hit;
	const result = synthUnderCdkConditions({
		imports: [
			"import { Auth } from '@aws-blocks/bb-auth';",
			"import { AppSetting } from '@aws-blocks/bb-app-setting';",
			"import { Secret } from '@aws-blocks/bb-secret';",
			"import { registerConfig } from '@aws-blocks/core/cdk';",
		].join('\n'),
		build: `${SECRETS}\n${options.before ?? ''}\nconst auth = ${construct};\n${options.after ?? ''}\nreport.fullId = auth.fullId;`,
		apiUrl: options.apiUrl,
	});
	cache.set(key, result);
	return result;
}

const HOSTING_ORIGIN = 'https://d111111abcdef8.cloudfront.net';
const withHosting: SynthOptions = { after: `registerConfig(stack, 'BLOCKS_PUBLIC_ORIGIN', '${HOSTING_ORIGIN}');` };

function byPath(template: CfnTemplateJson, path: string): [string, CfnResourceJson] | undefined {
	return Object.entries(template.Resources).find(
		([, r]) => r.Metadata?.['aws:cdk:path'] === `TestStack/auth/${path}`,
	);
}

function mustByPath(template: CfnTemplateJson, path: string): [string, CfnResourceJson] {
	const found = byPath(template, path);
	assert.ok(found, `no resource at TestStack/auth/${path}`);
	return found;
}

function ofType(template: CfnTemplateJson, type: string): [string, CfnResourceJson][] {
	return Object.entries(template.Resources).filter(([, r]) => r.Type === type);
}

/** Every resource the federation layer owns (by construct path under the block). */
function federationResources(template: CfnTemplateJson): string[] {
	return Object.values(template.Resources)
		.map((r) => String(r.Metadata?.['aws:cdk:path'] ?? ''))
		.filter((p) => /^TestStack\/auth\/(domain|hosted-ui-client|idp-|saml-)/.test(p))
		.sort();
}

function props(resource: [string, CfnResourceJson]): Record<string, unknown> {
	return resource[1].Properties ?? {};
}

/** A host that would mean a placeholder leaked into the template instead of a real front door. */
function isPlaceholderHost(hostname: string): boolean {
	if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return true;
	return ['example.com', 'example.org', 'example.net'].some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

/** Every absolute URL anywhere in a resource's properties, parsed (so checks run on the host, not a substring). */
function urlsIn(value: unknown): URL[] {
	if (typeof value === 'string') {
		try {
			return [new URL(value)];
		} catch {
			return [];
		}
	}
	if (Array.isArray(value)) return value.flatMap(urlsIn);
	if (value !== null && typeof value === 'object') return Object.values(value).flatMap(urlsIn);
	return [];
}

function hostedUiClient(template: CfnTemplateJson) {
	return mustByPath(template, 'hosted-ui-client/Resource');
}

function idpRegistration(template: CfnTemplateJson, id: string): Record<string, unknown> {
	return props(mustByPath(template, `idp-${id}/Default`));
}

// ── No federation → nothing new ──────────────────────────────────────────────

describe('Auth federation — provisions nothing without a Cognito-federated provider', () => {
	for (const name of ['default', 'directOnly'] as const) {
		test(`${name}: no domain, hosted-UI client, IdP, registration Lambda or custom resource`, () => {
			const { template } = synth(CONFIGS[name]);
			assert.deepStrictEqual(federationResources(template), []);
			assert.deepStrictEqual(ofType(template, 'AWS::Cognito::UserPoolDomain'), []);
			assert.deepStrictEqual(ofType(template, 'AWS::Cognito::UserPoolIdentityProvider'), []);
			assert.deepStrictEqual(ofType(template, 'Custom::BlocksAuthIdentityProvider'), []);
			// The only Lambdas are the harness handler and bb-app-setting's shared secret seeding.
			const fns = ofType(template, 'AWS::Lambda::Function').map(([, r]) => String(r.Metadata?.['aws:cdk:path']));
			assert.ok(
				fns.every((p) => !p.startsWith('TestStack/auth/')),
				`unexpected Lambda under the block: ${fns}`,
			);
		});

		test(`${name}: registers no federation config key`, () => {
			const s = synth(CONFIGS[name]);
			const keys = federationConfigKeys(String(s.report.fullId));
			assert.ok(!(keys.DOMAIN in s.config));
			assert.ok(!(keys.HOSTED_UI_CLIENT_ID in s.config));
		});
	}

	test('default: at most one app client (the frozen `client`), with OAuth disabled', () => {
		const clients = ofType(synth(CONFIGS.default).template, 'AWS::Cognito::UserPoolClient');
		assert.deepStrictEqual(
			clients.map(([id]) => id),
			['authclientB98ED767'],
		);
		assert.strictEqual(props(clients[0]).AllowedOAuthFlowsUserPoolClient, false);
	});
});

// ── The provisioning matrix ──────────────────────────────────────────────────

describe('Auth federation — provisioning matrix', () => {
	const matrix: {
		name: keyof typeof CONFIGS;
		resources: string[];
		providers: string[];
		lambda: boolean;
	}[] = [
		{
			name: 'socialOnly',
			resources: ['domain/Resource', 'hosted-ui-client/Resource', 'idp-google/Default'],
			providers: ['Google'],
			lambda: true,
		},
		{
			name: 'samlOnly',
			resources: ['domain/Resource', 'hosted-ui-client/Resource', 'saml-corp'],
			providers: ['corp'],
			lambda: false,
		},
		{
			name: 'cognitoOidcOnly',
			resources: ['domain/Resource', 'hosted-ui-client/Resource', 'idp-okta/Default'],
			providers: ['okta'],
			lambda: true,
		},
		{
			name: 'mixed',
			resources: [
				'domain/Resource',
				'hosted-ui-client/Resource',
				'idp-apple/Default',
				'idp-google/Default',
				'saml-corp',
			],
			providers: ['Google', 'SignInWithApple', 'corp'],
			lambda: true,
		},
	];

	for (const row of matrix) {
		describe(row.name, () => {
			test('exactly the federation resources for the configured providers', () => {
				const { template } = synth(CONFIGS[row.name]);
				const federation = federationResources(template).filter((p) => !p.includes('/idp-registration'));
				assert.deepStrictEqual(federation, row.resources.map((r) => `TestStack/auth/${r}`).sort());
			});

			test('the hosted-UI client supports exactly the configured federated providers (no COGNITO)', () => {
				const client = props(hostedUiClient(synth(CONFIGS[row.name]).template));
				assert.deepStrictEqual(client.SupportedIdentityProviders, row.providers);
			});

			test(`registration Lambda ${row.lambda ? 'present (a provider carries a secret)' : 'absent (SAML needs no secret)'}`, () => {
				const { template } = synth(CONFIGS[row.name]);
				assert.strictEqual(byPath(template, 'idp-registration-fn/Resource') !== undefined, row.lambda);
			});

			test('a domain, and both federation config keys pointing at it and at the hosted-UI client', () => {
				const s = synth(CONFIGS[row.name]);
				const keys = federationConfigKeys(String(s.report.fullId));
				const [domainId] = mustByPath(s.template, 'domain/Resource');
				const [clientId] = hostedUiClient(s.template);
				assert.deepStrictEqual(s.config[keys.DOMAIN], {
					'Fn::Join': ['', [{ Ref: domainId }, '.auth.', { Ref: 'AWS::Region' }, '.amazoncognito.com']],
				});
				assert.deepStrictEqual(s.config[keys.HOSTED_UI_CLIENT_ID], { Ref: clientId });
			});

			test('the frozen `client` keeps its logical id and no OAuth', () => {
				const { template } = synth(CONFIGS[row.name]);
				const client = mustByPath(template, 'client/Resource');
				assert.strictEqual(client[0], 'authclientB98ED767');
				assert.strictEqual(props(client).AllowedOAuthFlowsUserPoolClient, false);
				assert.strictEqual(props(client).GenerateSecret, false);
			});
		});
	}

	test("mixed's directly federated okta (its own `store: 'builtin'` block) is not registered with Cognito", () => {
		const { template } = synth(CONFIGS.mixed);
		assert.strictEqual(byPath(template, 'idp-okta/Default'), undefined);
		assert.ok(!(props(hostedUiClient(template)).SupportedIdentityProviders as string[]).includes('okta'));
		const ssoPaths = Object.values(template.Resources)
			.map((r) => String(r.Metadata?.['aws:cdk:path'] ?? ''))
			.filter((p) => p.startsWith('TestStack/sso/'));
		assert.ok(ssoPaths.length > 0, 'the sso block is in the stack');
		assert.deepStrictEqual(
			ssoPaths.filter((p) => /^TestStack\/sso\/(pool|client|domain|hosted-ui-client|idp-|saml-)/.test(p)),
			[],
		);
	});

	test('adding a social provider to the default config is additive: every default resource is unchanged', () => {
		const before = synth(CONFIGS.default).template;
		const after = synth(CONFIGS.defaultPlusGoogle).template;
		for (const [id, resource] of Object.entries(before.Resources)) {
			// The shared policy is compared below; the config upload legitimately gains the two federation keys.
			if (resource.Type === 'AWS::IAM::Policy' || resource.Type === 'Custom::CDKBucketDeployment') continue;
			assert.deepStrictEqual(after.Resources[id], resource, `${id} must survive unchanged`);
		}
		const sharedPolicy = (t: CfnTemplateJson) =>
			ofType(t, 'AWS::IAM::Policy').find(([, r]) =>
				String(r.Metadata?.['aws:cdk:path']).startsWith('TestStack/BlocksRole'),
			);
		assert.deepStrictEqual(
			sharedPolicy(after),
			sharedPolicy(before),
			'the runtime needs no new IAM for federation',
		);
	});
});

// ── Coexistence with the immutability guard (D4) ─────────────────────────────

describe('Auth federation — coexists with the immutability guard (D4)', () => {
	for (const name of ['socialOnly', 'samlOnly', 'cognitoOidcOnly', 'mixed'] as const) {
		test(`${name}: the pool guard and the federation resources are synthesized together`, () => {
			const { template } = synth(CONFIGS[name]);
			const guards = ofType(template, 'Custom::BlocksAuthPoolGuard');
			assert.strictEqual(guards.length, 1, 'one pool guard');
			const [guardId] = guards[0];
			const pool = mustByPath(template, 'pool/Resource');
			assert.ok([pool[1].DependsOn].flat().includes(guardId), 'the pool still waits for the guard');
			assert.ok(byPath(template, 'domain/Resource'));
			assert.ok(byPath(template, 'hosted-ui-client/Resource'));
			// The guard snapshots pool properties only: no federation resource depends on it, and it on none.
			for (const p of federationResources(template)) {
				const [, r] = mustByPath(template, p.slice('TestStack/auth/'.length));
				assert.ok(![r.DependsOn].flat().includes(guardId), `${p} must not depend on the guard`);
			}
		});
	}
});

// ── The hosted-UI client ─────────────────────────────────────────────────────

describe('Auth federation — the hosted-UI app client', () => {
	test('a separate client: public (no secret), authorization-code grant, OIDC scopes, refresh-only SDK flows', () => {
		const [id, resource] = hostedUiClient(synth(CONFIGS.socialOnly).template);
		assert.notStrictEqual(id, 'authclientB98ED767');
		assert.strictEqual(id, 'authhosteduiclient8CF4B242', 'the hosted-UI client id is stable once deployed');
		const p = resource.Properties ?? {};
		assert.strictEqual(p.GenerateSecret, false);
		assert.strictEqual(p.AllowedOAuthFlowsUserPoolClient, true);
		assert.deepStrictEqual(p.AllowedOAuthFlows, ['code']);
		assert.deepStrictEqual(p.AllowedOAuthScopes, ['openid', 'email', 'profile']);
		assert.deepStrictEqual(p.ExplicitAuthFlows, ['ALLOW_REFRESH_TOKEN_AUTH']);
		assert.strictEqual(p.PreventUserExistenceErrors, 'ENABLED');
	});

	test('depends on every IdP registration (Cognito rejects listing a provider that does not exist yet)', () => {
		const { template } = synth(CONFIGS.mixed);
		const deps = [hostedUiClient(template)[1].DependsOn].flat().sort();
		const idps = ['idp-apple/Default', 'idp-google/Default', 'saml-corp'].map((p) => mustByPath(template, p)[0]);
		assert.deepStrictEqual(deps, idps.sort());
	});
});

// ── Callback / logout URLs ───────────────────────────────────────────────────

describe('Auth federation — callback and logout URLs are the real front doors', () => {
	const API_BASE = HARNESS_API_URL.slice(0, -'/aws-blocks/api'.length);

	test('without Hosting: the API Gateway URL (from the compute apiUrl), never a localhost placeholder', () => {
		const p = props(hostedUiClient(synth(CONFIGS.socialOnly).template));
		assert.deepStrictEqual(p.CallbackURLs, [`${API_BASE}/aws-blocks/auth/callback`]);
		assert.deepStrictEqual(p.LogoutURLs, [`${API_BASE}/aws-blocks/auth/signout`]);
		const urls = urlsIn(p);
		assert.ok(urls.length >= 2, 'expected the callback and logout URLs to be found');
		for (const url of urls) {
			assert.ok(!isPlaceholderHost(url.hostname), `placeholder host in ${url.href}`);
		}
	});

	test('with Hosting registered AFTER Auth (as BlocksStack does): both the API and the public origin', () => {
		const p = props(hostedUiClient(synth(CONFIGS.socialOnly, withHosting).template));
		assert.deepStrictEqual(p.CallbackURLs, [
			`${API_BASE}/aws-blocks/auth/callback`,
			`${HOSTING_ORIGIN}/aws-blocks/auth/callback`,
		]);
		assert.deepStrictEqual(p.LogoutURLs, [
			`${API_BASE}/aws-blocks/auth/signout`,
			`${HOSTING_ORIGIN}/aws-blocks/auth/signout`,
		]);
	});

	test('a tokenized apiUrl (a real RestApi) resolves at deploy time via Fn::Split, like Hosting does', () => {
		const p = props(
			hostedUiClient(
				synth(CONFIGS.socialOnly, {
					apiUrl: null,
					// biome-ignore lint/suspicious/noTemplateCurlyInString: probe source — the template literal is evaluated in the synth child process.
					before: 'stack._defaultCompute = { apiUrl: `https://${cdk.Aws.STACK_NAME}.execute-api.${cdk.Aws.REGION}.amazonaws.com/prod/aws-blocks/api` };',
				}).template,
			),
		);
		const callbacks = p.CallbackURLs as unknown[];
		assert.strictEqual(callbacks.length, 1);
		const json = JSON.stringify(callbacks[0]);
		assert.match(json, /"Fn::Join"/);
		assert.match(json, /"Fn::Select":\[0,\{"Fn::Split":\["\/aws-blocks\/api"/);
		assert.match(json, /"\/aws-blocks\/auth\/callback"\]/);
	});

	test('custom redirects paths are honoured', () => {
		const p = props(
			hostedUiClient(
				synth(
					`new Auth(stack, 'auth', { providers: { ${P.google} }, redirects: { callbackPath: '/aws-blocks/auth/cb', signOutPath: '/aws-blocks/auth/bye' } })`,
				).template,
			),
		);
		assert.deepStrictEqual(p.CallbackURLs, [`${API_BASE}/aws-blocks/auth/cb`]);
		assert.deepStrictEqual(p.LogoutURLs, [`${API_BASE}/aws-blocks/auth/bye`]);
	});

	test('no compute API URL and no Hosting origin: synth fails rather than inventing a URL', () => {
		assert.throws(
			() => synth(CONFIGS.socialOnly, { apiUrl: null, before: 'stack._defaultCompute = {};' }),
			/hosted-UI federation needs a public URL for its callback URL/,
		);
	});

	test('the default paths sit under the reserved auth subtree (core BLOCKS_AUTH_PREFIX)', () => {
		assert.strictEqual(AUTH_ROUTE_PREFIX, BLOCKS_AUTH_PREFIX);
		assert.strictEqual(DEFAULT_CALLBACK_PATH, `${BLOCKS_AUTH_PREFIX}/callback`);
		assert.strictEqual(DEFAULT_SIGNOUT_PATH, `${BLOCKS_AUTH_PREFIX}/signout`);
	});
});

// ── IdP registration ─────────────────────────────────────────────────────────

describe('Auth federation — identity-provider registration', () => {
	const all = () => synth(CONFIGS.allSocial).template;

	test('Google: type Google, client id literal, secret by SSM parameter name only', () => {
		const p = idpRegistration(all(), 'google');
		assert.strictEqual(p.ProviderName, 'Google');
		assert.strictEqual(p.ProviderType, 'Google');
		assert.deepStrictEqual(p.ProviderDetails, { client_id: 'g-client', authorize_scopes: 'openid email profile' });
		assert.deepStrictEqual(p.SecretDetails, { client_secret: '/TestStack-google-secret' });
		assert.deepStrictEqual(p.AttributeMapping, { email: 'email', name: 'name' });
	});

	test('Facebook: comma-joined scopes', () => {
		const p = idpRegistration(all(), 'facebook');
		assert.strictEqual(p.ProviderType, 'Facebook');
		assert.deepStrictEqual(p.ProviderDetails, { client_id: 'fb-app', authorize_scopes: 'public_profile,email' });
		assert.deepStrictEqual(p.SecretDetails, { client_secret: '/TestStack-facebook-secret' });
	});

	test('Login with Amazon: provider name and type LoginWithAmazon', () => {
		const p = idpRegistration(all(), 'amazon');
		assert.strictEqual(p.ProviderName, 'LoginWithAmazon');
		assert.strictEqual(p.ProviderType, 'LoginWithAmazon');
		assert.deepStrictEqual(p.SecretDetails, { client_secret: '/TestStack-amazon-secret' });
	});

	test('Sign in with Apple: a real SignInWithApple provider (not OIDC), team + key id, private key as the secret', () => {
		const p = idpRegistration(all(), 'apple');
		assert.strictEqual(p.ProviderName, 'SignInWithApple');
		assert.strictEqual(p.ProviderType, 'SignInWithApple');
		assert.deepStrictEqual(p.ProviderDetails, {
			client_id: 'com.example.web',
			team_id: 'TEAM123',
			key_id: 'KEY456',
			authorize_scopes: 'email name',
		});
		assert.deepStrictEqual(p.SecretDetails, { private_key: '/TestStack-apple-key' });
	});

	test('Cognito-federated OIDC: issuer, attributes_request_method, endpoints, client secret by name', () => {
		const { template } = synth(
			`new Auth(stack, 'auth', { providers: { okta: { type: 'oidc', issuer: 'https://dev-1.okta.com', clientId: '0oa1', clientSecret: oktaSecret, attributesRequestMethod: 'POST', scopes: ['openid', 'email'], endpoints: { authorization: 'https://dev-1.okta.com/a', token: 'https://dev-1.okta.com/t', userInfo: 'https://dev-1.okta.com/u', jwks: 'https://dev-1.okta.com/k' }, attributeMapping: { given_name: 'given_name' } } } })`,
		);
		const p = idpRegistration(template, 'okta');
		assert.strictEqual(p.ProviderName, 'okta');
		assert.strictEqual(p.ProviderType, 'OIDC');
		assert.deepStrictEqual(p.ProviderDetails, {
			client_id: '0oa1',
			authorize_scopes: 'openid email',
			oidc_issuer: 'https://dev-1.okta.com',
			attributes_request_method: 'POST',
			authorize_url: 'https://dev-1.okta.com/a',
			token_url: 'https://dev-1.okta.com/t',
			attributes_url: 'https://dev-1.okta.com/u',
			jwks_uri: 'https://dev-1.okta.com/k',
		});
		assert.deepStrictEqual(p.SecretDetails, { client_secret: '/TestStack-okta-secret' });
		assert.deepStrictEqual(p.AttributeMapping, { email: 'email', name: 'name', given_name: 'given_name' });
	});

	test("Cognito-federated OIDC: attributes_request_method defaults to 'GET'", () => {
		const p = idpRegistration(synth(CONFIGS.cognitoOidcOnly).template, 'okta');
		assert.strictEqual((p.ProviderDetails as Record<string, string>).attributes_request_method, 'GET');
	});

	test('SAML (metadata URL): a native UserPoolIdentityProvider, default email claim mapping', () => {
		const p = props(mustByPath(synth(CONFIGS.samlOnly).template, 'saml-corp'));
		assert.deepStrictEqual(p, {
			ProviderName: 'corp',
			ProviderType: 'SAML',
			ProviderDetails: { MetadataURL: 'https://idp.example.com/metadata', IDPSignout: 'false' },
			AttributeMapping: { email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress' },
			UserPoolId: { Ref: 'authpoolBA1CDCB6' },
		});
	});

	test('SAML (metadata file) with signed requests and a custom-attribute mapping', () => {
		const p = props(
			mustByPath(
				synth(
					"new Auth(stack, 'auth', { users: { attributes: [{ name: 'tenant' }] }, providers: { entra: { type: 'saml', metadataFile: '<EntityDescriptor/>', signRequest: true, attributeMapping: { tenant: 'http://schemas.microsoft.com/identity/claims/tenantid' } } } })",
				).template,
				'saml-entra',
			),
		);
		assert.deepStrictEqual(p.ProviderDetails, {
			MetadataFile: '<EntityDescriptor/>',
			IDPSignout: 'false',
			RequestSigningAlgorithm: 'rsa-sha256',
		});
		assert.deepStrictEqual(p.AttributeMapping, {
			email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
			'custom:tenant': 'http://schemas.microsoft.com/identity/claims/tenantid',
		});
	});

	test('every Cognito-store provider type registers the same IdP resources as the replaced provider maps did', () => {
		// Logical ids, types and provider names recorded from a synth of the equivalent
		// `socialProviders` / `samlProviders` / `oidcProviders` (`federateVia: 'cognito'`) config.
		const { template } = synth(
			`new Auth(stack, 'auth', { providers: { ${P.google}, ${P.facebook}, ${P.amazon}, ${P.apple}, ${P.corpUrl}, ${P.oktaCognito} } })`,
		);
		const expected: [
			path: string,
			logicalId: string,
			type: string,
			providerName?: string,
			providerType?: string,
		][] = [
			['domain/Resource', 'authdomain7342FA14', 'AWS::Cognito::UserPoolDomain'],
			['hosted-ui-client/Resource', 'authhosteduiclient8CF4B242', 'AWS::Cognito::UserPoolClient'],
			['idp-google/Default', 'authidpgoogleA22FC3F1', 'Custom::BlocksAuthIdentityProvider', 'Google', 'Google'],
			[
				'idp-facebook/Default',
				'authidpfacebookF90C4C7D',
				'Custom::BlocksAuthIdentityProvider',
				'Facebook',
				'Facebook',
			],
			[
				'idp-amazon/Default',
				'authidpamazonF48463D5',
				'Custom::BlocksAuthIdentityProvider',
				'LoginWithAmazon',
				'LoginWithAmazon',
			],
			[
				'idp-apple/Default',
				'authidpappleB8B67C23',
				'Custom::BlocksAuthIdentityProvider',
				'SignInWithApple',
				'SignInWithApple',
			],
			['saml-corp', 'authsamlcorp39928492', 'AWS::Cognito::UserPoolIdentityProvider', 'corp', 'SAML'],
			['idp-okta/Default', 'authidpoktaB71894C8', 'Custom::BlocksAuthIdentityProvider', 'okta', 'OIDC'],
		];
		for (const [path, logicalId, type, providerName, providerType] of expected) {
			const [id, resource] = mustByPath(template, path);
			assert.strictEqual(id, logicalId, path);
			assert.strictEqual(resource.Type, type, path);
			if (providerName) {
				assert.strictEqual(props([id, resource]).ProviderName, providerName, path);
				assert.strictEqual(props([id, resource]).ProviderType, providerType, path);
			}
		}
		assert.deepStrictEqual(
			federationResources(template).filter((p) => !p.includes('/idp-registration')),
			expected.map(([path]) => `TestStack/auth/${path}`).sort(),
		);
		assert.deepStrictEqual(props(hostedUiClient(template)).SupportedIdentityProviders, [
			'Google',
			'Facebook',
			'LoginWithAmazon',
			'SignInWithApple',
			'corp',
			'okta',
		]);
	});

	test('no secret value or ssm-secure reference ever reaches the template', () => {
		const json = JSON.stringify(all());
		assert.ok(!json.includes('ssm-secure'));
		for (const [, r] of ofType(all(), 'Custom::BlocksAuthIdentityProvider')) {
			const details = r.Properties?.ProviderDetails as Record<string, string>;
			assert.ok(!('client_secret' in details) && !('private_key' in details));
		}
	});

	test('each registration runs after the secret seeding (BlocksSecretsBulk)', () => {
		for (const id of ['google', 'facebook', 'amazon', 'apple']) {
			const [, r] = mustByPath(all(), `idp-${id}/Default`);
			assert.deepStrictEqual([r.DependsOn].flat(), ['BlocksSecretsBulk'], id);
		}
	});

	test('the registration Lambda can read exactly the provider secrets and manage IdPs on this pool only', () => {
		const template = all();
		const policy = Object.values(template.Resources).find(
			(r) =>
				r.Type === 'AWS::IAM::Policy' &&
				String(r.Metadata?.['aws:cdk:path']).startsWith('TestStack/auth/idp-registration-fn/'),
		);
		assert.ok(policy);
		const statements = ((policy.Properties?.PolicyDocument ?? {}) as { Statement: Record<string, unknown>[] })
			.Statement;
		const byAction = (a: string) => statements.find((s) => [s.Action].flat().includes(a));
		assert.deepStrictEqual(byAction('cognito-idp:CreateIdentityProvider')?.Resource, {
			'Fn::GetAtt': ['authpoolBA1CDCB6', 'Arn'],
		});
		const ssm = JSON.stringify(byAction('ssm:GetParameter')?.Resource);
		for (const name of ['google-secret', 'facebook-secret', 'amazon-secret', 'apple-key']) {
			assert.ok(ssm.includes(`:parameter/TestStack-${name}`), `missing ${name}`);
		}
		assert.ok(!ssm.includes('okta-secret'), 'grants only the secrets of registered providers');
		assert.deepStrictEqual(byAction('kms:Decrypt')?.Condition, {
			StringEquals: {
				'kms:ViaService': { 'Fn::Join': ['', ['ssm.', { Ref: 'AWS::Region' }, '.amazonaws.com']] },
			},
		});
	});
});

// ── Provider secrets resolve through AppSetting.parameterName ────────────────

describe('Auth federation — a provider secret resolves to its AppSetting parameterName', () => {
	const withSecret = (secretExpr: string) =>
		`new Auth(stack, 'auth', { providers: { google: { type: 'google', clientId: 'g', clientSecret: ${secretExpr} } } })`;

	/** The `client_secret` SSM name registered for google, and the SSM ARNs the registration Lambda may read. */
	function registered(template: CfnTemplateJson): { name: unknown; ssmResources: string } {
		const [, idp] = mustByPath(template, 'idp-google/Default');
		const policy = Object.values(template.Resources).find(
			(r) =>
				r.Type === 'AWS::IAM::Policy' &&
				String(r.Metadata?.['aws:cdk:path']).startsWith('TestStack/auth/idp-registration-fn/'),
		);
		assert.ok(policy, 'the registration Lambda has a policy');
		const statements = ((policy.Properties?.PolicyDocument ?? {}) as { Statement: Record<string, unknown>[] })
			.Statement;
		const ssm = statements.find((st) => [st.Action].flat().includes('ssm:GetParameter'));
		return {
			name: ((idp.Properties?.SecretDetails ?? {}) as Record<string, unknown>).client_secret,
			ssmResources: JSON.stringify(ssm?.Resource),
		};
	}

	test('a secret AppSetting at its default name registers /<fullId>', () => {
		const { name, ssmResources } = registered(synth(CONFIGS.socialOnly).template);
		assert.strictEqual(name, '/TestStack-google-secret');
		assert.ok(ssmResources.includes(':parameter/TestStack-google-secret'), ssmResources);
	});

	test('an AppSetting with an explicit `name` registers that name', () => {
		const { name, ssmResources } = registered(
			synth(withSecret("new AppSetting(stack, 'named', { secret: true, name: '/my/google-secret' })")).template,
		);
		assert.strictEqual(name, '/my/google-secret');
		assert.ok(ssmResources.includes(':parameter/my/google-secret'), ssmResources);
		assert.ok(!ssmResources.includes('TestStack-named'), 'never the guessed /<fullId>');
	});

	test('an AppSetting from fromExisting() registers the external name', () => {
		const template = synth(
			withSecret("AppSetting.fromExisting(stack, 'ext', { name: '/shared/google', secret: true })"),
		).template;
		const { name, ssmResources } = registered(template);
		assert.strictEqual(name, '/shared/google');
		assert.ok(ssmResources.includes(':parameter/shared/google'), ssmResources);
		assert.ok(!ssmResources.includes('TestStack-ext'), 'never the guessed /<fullId>');
	});

	test('a non-secret AppSetting is refused (a plaintext provider secret)', () => {
		assert.throws(
			() => synth(withSecret("new AppSetting(stack, 'plain', { value: 'x' })")),
			/providers\.google\.clientSecret \('TestStack-plain', SSM parameter '\/TestStack-plain'\) must be an AppSetting with `secret: true`/,
		);
		assert.throws(
			() => synth(withSecret("AppSetting.fromExisting(stack, 'ext-plain', { name: '/shared/plain' })")),
			/must be an AppSetting with `secret: true`/,
		);
	});

	test('a hand-made { fullId, get } object is refused: it has no parameter name', () => {
		assert.throws(
			() => synth(withSecret("{ fullId: 'TestStack-nowhere', get: async () => 'x' }")),
			/providers\.google\.clientSecret \('TestStack-nowhere'\) is not an AppSetting — it has no SSM parameter name/,
		);
	});
});

// ── Provider secrets given as a `Secret` (Secrets Manager) ──────────────────

describe('Auth federation — a provider secret given as a Secret', () => {
	const withSecret = (secretExpr: string) =>
		`new Auth(stack, 'auth', { providers: { google: { type: 'google', clientId: 'g', clientSecret: ${secretExpr} } } })`;

	/** Every statement of the registration Lambda's policy. */
	function registrationStatements(template: CfnTemplateJson): Record<string, unknown>[] {
		const policy = Object.values(template.Resources).find(
			(r) =>
				r.Type === 'AWS::IAM::Policy' &&
				String(r.Metadata?.['aws:cdk:path']).startsWith('TestStack/auth/idp-registration-fn/'),
		);
		assert.ok(policy, 'the registration Lambda has a policy');
		return ((policy.Properties?.PolicyDocument ?? {}) as { Statement: Record<string, unknown>[] }).Statement;
	}
	const withAction = (statements: Record<string, unknown>[], action: string) =>
		statements.filter((st) => [st.Action].flat().includes(action));

	test('a stack-managed Secret registers by its ARN, read only by the registration Lambda', () => {
		const { template } = synth(withSecret("new Secret(stack, 'google-sm')"));
		const p = idpRegistration(template, 'google');
		assert.deepStrictEqual(p.SecretDetails, {}, 'nothing read from SSM');
		const [secretId] = ofType(template, 'AWS::SecretsManager::Secret').find(([, r]) =>
			String(r.Metadata?.['aws:cdk:path']).startsWith('TestStack/google-sm/'),
		) ?? [undefined];
		assert.ok(secretId, 'the Secret is in the template');
		assert.deepStrictEqual(p.SecretsManagerDetails, { client_secret: { Ref: secretId } });

		const statements = registrationStatements(template);
		const read = withAction(statements, 'secretsmanager:GetSecretValue');
		assert.strictEqual(read.length, 1);
		assert.deepStrictEqual(read[0].Resource, { Ref: secretId }, 'exactly this secret, never a wildcard');
		const decrypt = withAction(statements, 'kms:Decrypt');
		assert.deepStrictEqual(
			decrypt.map((st) => JSON.stringify(st.Condition)),
			[
				JSON.stringify({
					StringEquals: {
						'kms:ViaService': {
							'Fn::Join': ['', ['secretsmanager.', { Ref: 'AWS::Region' }, '.amazonaws.com']],
						},
					},
				}),
			],
			'decrypt only via Secrets Manager',
		);
		assert.deepStrictEqual(withAction(statements, 'ssm:GetParameter'), [], 'no SSM grant without an SSM secret');
	});

	test('a Secret.fromExisting() ARN is registered and granted verbatim', () => {
		const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/google-AbCdEf';
		const { template } = synth(withSecret(`new Secret(stack, 'ext', { secret: Secret.fromExisting('${arn}') })`));
		assert.deepStrictEqual(idpRegistration(template, 'google').SecretsManagerDetails, { client_secret: arn });
		const read = withAction(registrationStatements(template), 'secretsmanager:GetSecretValue');
		assert.deepStrictEqual(
			read.map((st) => st.Resource),
			[arn],
		);
	});

	test('Apple private key and a cognito-federated OIDC secret accept a Secret too; AppSettings keep SSM', () => {
		const { template } = synth(
			`new Auth(stack, 'auth', { providers: { ${P.google}, apple: { type: 'apple', clientId: 'com.example.web', teamId: 'T', keyId: 'K', privateKey: new Secret(stack, 'apple-sm') }, okta: { type: 'oidc', issuer: 'https://dev-1.okta.com', clientId: '0oa1', clientSecret: new Secret(stack, 'okta-sm') } } })`,
		);
		const apple = idpRegistration(template, 'apple');
		assert.deepStrictEqual(apple.SecretDetails, {});
		assert.deepStrictEqual(Object.keys(apple.SecretsManagerDetails as object), ['private_key']);
		const okta = idpRegistration(template, 'okta');
		assert.deepStrictEqual(Object.keys(okta.SecretsManagerDetails as object), ['client_secret']);
		const google = idpRegistration(template, 'google');
		assert.deepStrictEqual(google.SecretDetails, { client_secret: '/TestStack-google-secret' });
		assert.ok(!('SecretsManagerDetails' in google), 'an AppSetting-only registration keeps its old properties');
		const statements = registrationStatements(template);
		assert.strictEqual(withAction(statements, 'ssm:GetParameter').length, 1);
		assert.strictEqual(withAction(statements, 'secretsmanager:GetSecretValue').length, 1);
	});

	test('a stack-managed Secret with no value warns at synth (the first deploy would fail); a valued one does not', () => {
		const warningsFor = (construct: string) =>
			synth(construct).warnings.filter((w) => /ProviderSecretWithoutValue|creates with no value/.test(w.message));
		const valueless = warningsFor(withSecret("new Secret(stack, 'google-sm')"));
		assert.strictEqual(valueless.length, 1);
		assert.match(valueless[0].message, /providers\.google\.clientSecret is the Secret 'TestStack-google-sm'/);
		assert.match(valueless[0].message, /generate: true/);
		assert.match(valueless[0].message, /npm run secret -- set/);
		assert.match(valueless[0].message, /already exists/);
		assert.match(valueless[0].message, /delete-secret/);

		assert.deepStrictEqual(warningsFor(withSecret("new Secret(stack, 'google-gen', { generate: true })")), []);
		assert.deepStrictEqual(
			warningsFor(
				withSecret(
					"new Secret(stack, 'ext', { secret: Secret.fromExisting('arn:aws:secretsmanager:us-east-1:123456789012:secret:g-AbCdEf') })",
				),
			),
			[],
			'an existing secret is owned outside the stack',
		);
		assert.deepStrictEqual(warningsFor(CONFIGS.socialOnly), [], 'an AppSetting is seeded by the deploy');
		const apple = warningsFor(
			`new Auth(stack, 'auth', { providers: { apple: { type: 'apple', clientId: 'com.example.web', teamId: 'T', keyId: 'K', privateKey: new Secret(stack, 'apple-sm') } } })`,
		);
		assert.strictEqual(apple.length, 1);
		assert.match(apple[0].message, /providers\.apple\.privateKey/);
	});

	test('an AppSetting-only configuration adds no Secrets Manager property or grant', () => {
		const { template } = synth(CONFIGS.allSocial);
		for (const id of ['google', 'facebook', 'amazon', 'apple']) {
			assert.ok(!('SecretsManagerDetails' in idpRegistration(template, id)), id);
		}
		assert.deepStrictEqual(withAction(registrationStatements(template), 'secretsmanager:GetSecretValue'), []);
	});
});

// ── Domain prefix ────────────────────────────────────────────────────────────

describe('Auth federation — the hosted-UI domain prefix', () => {
	test('derived deterministically from fullId (pinned: changing it replaces the domain in every deployment)', () => {
		assert.strictEqual(deriveDomainPrefix('TestStack-auth'), 'teststack-auth-fe925894');
		const domain = props(mustByPath(synth(CONFIGS.socialOnly).template, 'domain/Resource'));
		assert.strictEqual(domain.Domain, 'teststack-auth-fe925894');
		assert.strictEqual(deriveDomainPrefix('TestStack-auth'), deriveDomainPrefix('TestStack-auth'));
	});

	test('always valid: lowercase alphanumerics and hyphens, ≤ 63, no edge hyphen, no reserved word', () => {
		const inputs = [
			'TestStack-auth',
			'my-aws-app-prod-auth',
			'AmazonCognitoApp-auth',
			'awamazons-cogcognitonito',
			'___',
			'-',
			'Ünïcødé-stack-auth',
			'a'.repeat(128),
			`${'x-'.repeat(60)}auth`,
			'App_With.Dots-auth',
		];
		const seen = new Set<string>();
		for (const fullId of inputs) {
			const prefix = deriveDomainPrefix(fullId);
			assert.match(prefix, DOMAIN_PREFIX_PATTERN, fullId);
			assert.ok(prefix.length <= 63, fullId);
			for (const word of RESERVED_DOMAIN_WORDS) assert.ok(!prefix.includes(word), `${fullId} → ${prefix}`);
			seen.add(prefix);
		}
		assert.strictEqual(seen.size, inputs.length, 'distinct fullIds give distinct prefixes');
	});

	test('two long fullIds that differ only past the truncation point still differ (the hash)', () => {
		const a = deriveDomainPrefix(`${'a'.repeat(80)}-one`);
		const b = deriveDomainPrefix(`${'a'.repeat(80)}-two`);
		assert.notStrictEqual(a, b);
	});

	test('the hostedUi.domainPrefix override is used verbatim', () => {
		const domain = props(
			mustByPath(
				synth(
					`new Auth(stack, 'auth', { providers: { ${P.google} }, hostedUi: { domainPrefix: 'my-shop-login' } })`,
				).template,
				'domain/Resource',
			),
		);
		assert.strictEqual(domain.Domain, 'my-shop-login');
	});
});

// ── emailPassword: false hardening ───────────────────────────────────────────

describe('Auth federation — emailPassword: false leaves no password flow on `client`', () => {
	const clientOf = (construct: string) => mustByPath(synth(construct).template, 'client/Resource');

	test('default: USER_PASSWORD_AUTH + refresh (unchanged from AuthCognito)', () => {
		assert.deepStrictEqual(props(clientOf(CONFIGS.default)).ExplicitAuthFlows, [
			'ALLOW_USER_PASSWORD_AUTH',
			'ALLOW_REFRESH_TOKEN_AUTH',
		]);
	});

	for (const name of ['socialOnly', 'samlOnly', 'cognitoOidcOnly'] as const) {
		test(`${name}: refresh-token only, same logical id, every other property unchanged`, () => {
			const off = clientOf(CONFIGS[name]);
			const on = clientOf(CONFIGS.default);
			assert.strictEqual(off[0], 'authclientB98ED767');
			assert.strictEqual(off[0], on[0]);
			assert.deepStrictEqual(props(off).ExplicitAuthFlows, ['ALLOW_REFRESH_TOKEN_AUTH']);
			const { ExplicitAuthFlows: _a, ...restOff } = props(off);
			const { ExplicitAuthFlows: _b, ...restOn } = props(on);
			assert.deepStrictEqual(restOff, restOn);
		});
	}

	test("with users.authFlow: 'USER_AUTH' too: refresh-token only (no ALLOW_USER_AUTH)", () => {
		const p = props(
			clientOf(
				`new Auth(stack, 'auth', { emailPassword: false, users: { authFlow: 'USER_AUTH' }, providers: { ${P.google} } })`,
			),
		);
		assert.deepStrictEqual(p.ExplicitAuthFlows, ['ALLOW_REFRESH_TOKEN_AUTH']);
	});
});

// ── Synth-time checks (in process) ───────────────────────────────────────────

/** A bare stack that the CDK `Scope` accepts as a parent (test plumbing). */
function newStack(): ScopeParent {
	const stack = Object.assign(new cdk.Stack(new cdk.App(), 'TestStack'), { id: 'TestStack' });
	return stack as unknown as ScopeParent;
}

/** Construct `Auth` with untyped `options` (as a JavaScript caller might) and return the thrown message. */
function constructError(options: unknown): string {
	try {
		new Auth(newStack(), 'auth', options as AuthOptions);
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
	assert.fail('expected the Auth constructor to throw');
}

/** Stands in for an `AppSetting` (CDK layer): `parameterName` and `secret` are what `Auth` reads. */
const secret = { fullId: 'TestStack-s', get: async () => 'x', parameterName: '/TestStack-s', secret: true };
const google = { type: 'google', clientId: 'g', clientSecret: secret };

describe('Auth federation — synth-time checks', () => {
	test('one entry per social type: a social entry must be keyed by its type', () => {
		// One `providers` map cannot repeat an id; what remains is two entries of one social type.
		assert.match(
			constructError({ providers: { google, gmail: { ...google } } }),
			/providers\.gmail has `type: 'google'`, so its key must be `google`/,
		);
	});

	test('SAML needs exactly one metadata source, and an https URL', () => {
		assert.match(
			constructError({ providers: { corp: { type: 'saml' } } }),
			/exactly one of `metadataUrl` or `metadataFile`/,
		);
		assert.match(
			constructError({ providers: { corp: { type: 'saml', metadataUrl: 'https://x/m', metadataFile: '<x/>' } } }),
			/exactly one of/,
		);
		assert.match(
			constructError({ providers: { corp: { type: 'saml', metadataUrl: 'http://idp.example.com/m' } } }),
			/must use https/,
		);
	});

	test('Apple needs a team id and key id; social secrets must be AppSetting references', () => {
		assert.match(
			constructError({ providers: { apple: { type: 'apple', clientId: 'c', keyId: 'k', privateKey: secret } } }),
			/providers\.apple\.teamId is required/,
		);
		assert.match(
			constructError({ providers: { google: { ...google, clientSecret: 'plain-text' } } }),
			/clientSecret must be an AppSetting reference/,
		);
	});

	test("a `type: 'oidc'` provider of the Cognito store without a client secret", () => {
		assert.match(
			constructError({
				providers: { okta: { type: 'oidc', issuer: 'https://dev-1.okta.com', clientId: 'x' } },
			}),
			/`providers\.okta\.clientSecret` is required with `store: 'cognito'`.*confidential client/,
		);
	});

	test('OIDC / SAML ids must be valid, unreserved Cognito provider names', () => {
		assert.match(
			constructError({ providers: { ab: { type: 'saml', metadataUrl: 'https://x/m' } } }),
			/not a valid Cognito provider name/,
		);
		assert.match(
			constructError({ providers: { 'my corp': { type: 'saml', metadataUrl: 'https://x/m' } } }),
			/not a valid Cognito provider name/,
		);
		assert.match(
			constructError({ providers: { Google: { type: 'saml', metadataUrl: 'https://x/m' } } }),
			/reserved by Cognito/,
		);
	});

	test('an unknown provider type (untyped callers)', () => {
		// Rejected by the options resolver, before the CDK layer's own checks.
		assert.match(
			constructError({ providers: { github: { ...google, type: 'github' } } }),
			/providers\.github has `type: 'github'`, which is not a provider type/,
		);
	});

	test('attribute mappings: identity keys and unknown attributes are rejected', () => {
		assert.match(
			constructError({ providers: { google: { ...google, attributeMapping: { sub: 'sub' } } } }),
			/identity attributes are not mappable/,
		);
		assert.match(
			constructError({ providers: { google: { ...google, attributeMapping: { tier: 'tier' } } } }),
			/neither a Cognito standard attribute nor a declared/,
		);
	});

	test('redirect paths must be explicit paths under /aws-blocks/auth/', () => {
		assert.match(
			constructError({ providers: { google }, redirects: { callbackPath: '/callback' } }),
			/redirects\.callbackPath must be an explicit path under '\/aws-blocks\/auth\/'/,
		);
		assert.match(
			constructError({ providers: { google }, redirects: { signOutPath: '/aws-blocks/auth/*' } }),
			/redirects\.signOutPath/,
		);
	});

	test('hostedUi.domainPrefix must be a valid, unreserved Cognito prefix', () => {
		for (const bad of ['Upper', '-edge', 'edge-', 'has_underscore', 'a'.repeat(64), '']) {
			assert.match(
				constructError({ providers: { google }, hostedUi: { domainPrefix: bad } }),
				/not a valid/,
				bad,
			);
		}
		assert.match(
			constructError({ providers: { google }, hostedUi: { domainPrefix: 'my-aws-login' } }),
			/contains 'aws', which Cognito reserves/,
		);
	});

	test('hosted-UI federation on a wrapped existing pool is refused', () => {
		assert.match(
			constructError({ userPool: Auth.fromExisting('us-east-1_x'), providers: { google } }),
			/cannot be combined with `userPool`/,
		);
	});
});

// ── The contract the runtime shares ──────────────────────────────────────────

describe('Auth federation — contract helpers', () => {
	test('cognitoProviderName: fixed names for social providers, the id otherwise', () => {
		assert.strictEqual(cognitoProviderName('social', 'google'), 'Google');
		assert.strictEqual(cognitoProviderName('social', 'facebook'), 'Facebook');
		assert.strictEqual(cognitoProviderName('social', 'amazon'), 'LoginWithAmazon');
		assert.strictEqual(cognitoProviderName('social', 'apple'), 'SignInWithApple');
		assert.strictEqual(cognitoProviderName('oidc', 'okta'), 'okta');
		assert.strictEqual(cognitoProviderName('saml', 'corp'), 'corp');
	});

	test('cognitoFederatedProviders: social, then SAML, then Cognito OIDC; direct OIDC excluded', () => {
		assert.deepStrictEqual(
			cognitoFederatedProviders({
				oidcProviders: {
					direct: { issuer: 'https://a.example.com', clientId: 'a' },
					viaCognito: {
						issuer: 'https://b.example.com',
						clientId: 'b',
						clientSecret: secret,
						federateVia: 'cognito',
					},
				},
				samlProviders: { corp: { metadataUrl: 'https://x/m' } },
				socialProviders: { apple: { clientId: 'c', teamId: 't', keyId: 'k', privateKey: secret } },
			}),
			[
				{ id: 'apple', kind: 'social', providerName: 'SignInWithApple' },
				{ id: 'corp', kind: 'saml', providerName: 'corp' },
				{ id: 'viaCognito', kind: 'oidc', providerName: 'viaCognito' },
			],
		);
	});

	test('federationConfigKeys: under the AuthCognito key prefix, distinct from the frozen three', () => {
		assert.deepStrictEqual(federationConfigKeys('TestStack-auth'), {
			DOMAIN: 'BLOCKS_AUTH_COGNITO_TESTSTACK_AUTH_DOMAIN',
			HOSTED_UI_CLIENT_ID: 'BLOCKS_AUTH_COGNITO_TESTSTACK_AUTH_HOSTED_UI_CLIENT_ID',
		});
	});
});
