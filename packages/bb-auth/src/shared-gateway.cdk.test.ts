// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `Auth` on core's shared stack-level REST API (#734).
 *
 * The gateway belongs to the backend root and is built by `BlocksStack.create()`
 * after the backend module has imported, so it doesn't exist while `Auth` is
 * constructed. The URLs `Auth` derives from it (the hosted-UI callback and
 * logout URLs, a deployed stub IdP's issuer) are therefore lazy tokens. These
 * tests synthesize real `BlocksStack` apps and check they resolve to that
 * shared gateway — and, under `apiFrontDoor: 'cloudfront'` (#735), also to the
 * CloudFront distribution that fronts it, since the runtime then builds its
 * `redirect_uri` on that public origin.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import { synthBlocksApp } from './test-support/blocks-app-synth.js';
import type { CfnTemplateJson } from './test-support/cdk-synth.js';
import { freshAppDir } from './test-support/guard-synth.js';

function only(template: CfnTemplateJson, type: string): [string, CfnTemplateJson['Resources'][string]][] {
	return Object.entries(template.Resources).filter(([, r]) => r.Type === type);
}

describe('Auth on the shared stack-level REST API', () => {
	const dirs: string[] = [];
	after(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	test('hosted-UI callback and logout URLs point at the shared gateway', () => {
		const appDir = freshAppDir();
		dirs.push(appDir);
		const result = synthBlocksApp({
			appDir,
			build: `new Auth(stack, 'auth', { socialProviders: { google: { clientId: 'g', clientSecret: new AppSetting(stack, 'g-secret', { secret: true }) } } });`,
		});
		assert.ok(result.ok, result.stderr);
		assert.ok(result.template);

		const apis = only(result.template, 'AWS::ApiGateway::RestApi');
		assert.strictEqual(apis.length, 1, 'one shared REST API for the stack');
		const [apiId] = apis[0];

		// The hosted-UI client is the pool client with OAuth flows; the native `client` has none.
		const hostedUi = only(result.template, 'AWS::Cognito::UserPoolClient').filter(
			([, r]) => (r.Properties?.AllowedOAuthFlows as unknown[] | undefined)?.length,
		);
		assert.strictEqual(hostedUi.length, 1, 'one hosted-UI client');
		const props = hostedUi[0][1].Properties ?? {};
		for (const key of ['CallbackURLs', 'LogoutURLs']) {
			const json = JSON.stringify(props[key]);
			assert.ok(json.includes(`"Ref":"${apiId}"`), `${key} should reference the shared RestApi ${apiId}: ${json}`);
			assert.ok(!json.includes('localhost') && !json.includes('example.invalid'), `${key}: ${json}`);
		}
	});

	test('a deployed stub IdP synthesizes against the shared gateway', () => {
		const appDir = freshAppDir();
		dirs.push(appDir);
		const result = synthBlocksApp({
			appDir,
			build: `new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { corp: stubIdp({ unsafeAllowDeployed: true }) } });`,
		});
		assert.ok(result.ok, result.stderr);
		assert.strictEqual(only(result.template ?? { Resources: {} }, 'AWS::ApiGateway::RestApi').length, 1);
	});

	/** The hosted-UI client's `CallbackURLs` / `LogoutURLs`, as JSON. */
	function hostedUiUrls(template: CfnTemplateJson): Record<'CallbackURLs' | 'LogoutURLs', string> {
		const hostedUi = only(template, 'AWS::Cognito::UserPoolClient').filter(
			([, r]) => (r.Properties?.AllowedOAuthFlows as unknown[] | undefined)?.length,
		);
		assert.strictEqual(hostedUi.length, 1, 'one hosted-UI client');
		const props = hostedUi[0][1].Properties ?? {};
		return { CallbackURLs: JSON.stringify(props.CallbackURLs), LogoutURLs: JSON.stringify(props.LogoutURLs) };
	}

	const GOOGLE = `new Auth(stack, 'auth', { socialProviders: { google: { clientId: 'g', clientSecret: new AppSetting(stack, 'g-secret', { secret: true }) } } });`;

	test("apiFrontDoor: 'cloudfront' — the callback and logout URLs also name the CloudFront front door", () => {
		const appDir = freshAppDir();
		dirs.push(appDir);
		const result = synthBlocksApp({ appDir, build: GOOGLE, createOptions: "apiFrontDoor: 'cloudfront'," });
		assert.ok(result.ok, result.stderr);
		assert.ok(result.template);
		const distributions = only(result.template, 'AWS::CloudFront::Distribution');
		assert.strictEqual(distributions.length, 1, 'the managed API front door');
		const [distId] = distributions[0];
		const [apiId] = only(result.template, 'AWS::ApiGateway::RestApi')[0];
		for (const [key, json] of Object.entries(hostedUiUrls(result.template))) {
			assert.ok(json.includes(`"${distId}","DomainName"`), `${key} should name the front door ${distId}: ${json}`);
			assert.ok(json.includes(`"Ref":"${apiId}"`), `${key} keeps the gateway's own URL: ${json}`);
		}
	});

	test("apiFrontDoor: 'apigateway' (the default) — no distribution, gateway URLs only", () => {
		const appDir = freshAppDir();
		dirs.push(appDir);
		const result = synthBlocksApp({ appDir, build: GOOGLE, createOptions: "apiFrontDoor: 'apigateway'," });
		assert.ok(result.ok, result.stderr);
		assert.ok(result.template);
		assert.strictEqual(only(result.template, 'AWS::CloudFront::Distribution').length, 0);
		for (const [key, json] of Object.entries(hostedUiUrls(result.template))) {
			assert.ok(!json.includes('DomainName'), `${key} names no distribution: ${json}`);
		}
	});

	test("apiFrontDoor: 'cloudfront' — a deployed stub IdP still synthesizes", () => {
		const appDir = freshAppDir();
		dirs.push(appDir);
		const result = synthBlocksApp({
			appDir,
			build: `new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { corp: stubIdp({ unsafeAllowDeployed: true }) } });`,
			createOptions: "apiFrontDoor: 'cloudfront',",
		});
		assert.ok(result.ok, result.stderr);
	});
});
