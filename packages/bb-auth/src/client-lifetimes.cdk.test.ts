// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The app clients' token lifetimes and refresh-token rotation (`session.*`):
 * explicit defaults on both clients, the options that change them, and the
 * synth-time checks. Real synth under `--conditions=cdk`.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { type CfnResourceJson, synthUnderCdkConditions } from './test-support/cdk-synth.js';

const GOOGLE =
	"google: { type: 'google', clientId: 'g-client', clientSecret: new AppSetting(stack, 'idp-secret', { secret: true }) }";

function clients(construct: string): Record<string, CfnResourceJson> {
	const { template } = synthUnderCdkConditions({
		imports:
			"import { Auth } from '@aws-cdk-blocks/bb-auth';\nimport { AppSetting } from '@aws-cdk-blocks/bb-app-setting';",
		build: `const auth = ${construct};`,
	});
	const out: Record<string, CfnResourceJson> = {};
	for (const r of Object.values(template.Resources)) {
		if (r.Type !== 'AWS::Cognito::UserPoolClient') continue;
		out[String(r.Metadata?.['aws:cdk:path']).replace('TestStack/auth/', '')] = r;
	}
	return out;
}

const DEFAULTS = {
	AccessTokenValidity: 60,
	IdTokenValidity: 60,
	RefreshTokenValidity: 43_200,
	TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'minutes' },
	RefreshTokenRotation: { Feature: 'ENABLED', RetryGracePeriodSeconds: 10 },
};

describe('app client lifetimes', () => {
	test('defaults: 1 hour access and ID tokens, 30 day refresh token, rotation on, on both clients', () => {
		const c = clients(`new Auth(stack, 'auth', { providers: { ${GOOGLE} } })`);
		assert.deepStrictEqual(Object.keys(c).sort(), ['client/Resource', 'hosted-ui-client/Resource']);
		for (const r of Object.values(c)) {
			const p = r.Properties ?? {};
			for (const [k, v] of Object.entries(DEFAULTS)) assert.deepStrictEqual(p[k], v, k);
			assert.ok(
				!(p.ExplicitAuthFlows as string[]).includes('ALLOW_REFRESH_TOKEN_AUTH'),
				'rotation drops the flow',
			);
		}
	});

	test('the options change them; the refresh token follows ttlSeconds unless set', () => {
		const p = clients(
			"new Auth(stack, 'auth', { session: { ttlSeconds: 7 * 86400, accessTokenValiditySeconds: 1800, refreshTokenRotation: false } })",
		)['client/Resource'].Properties;
		assert.strictEqual(p?.AccessTokenValidity, 30);
		assert.strictEqual(p?.RefreshTokenValidity, 7 * 1440);
		assert.strictEqual(p?.RefreshTokenRotation, undefined);
		assert.ok((p?.ExplicitAuthFlows as string[] | undefined)?.includes('ALLOW_REFRESH_TOKEN_AUTH'));
		const q = clients("new Auth(stack, 'auth', { session: { refreshTokenValiditySeconds: 86_400 * 90 } })")[
			'client/Resource'
		].Properties;
		assert.strictEqual(q?.RefreshTokenValidity, 90 * 1440);
	});

	test('a non-numeric ttlSeconds from an untyped caller is reported against ttlSeconds', () => {
		assert.throws(
			() => clients("new Auth(stack, 'auth', { session: { ttlSeconds: '2592000' } })"),
			/session\.ttlSeconds must be a number/,
		);
	});

	test('values Cognito would reject fail at synth', () => {
		for (const session of [
			'accessTokenValiditySeconds: 60',
			'idTokenValiditySeconds: 90000',
			'refreshTokenValiditySeconds: 1000',
			'accessTokenValiditySeconds: 7200, refreshTokenValiditySeconds: 3600',
		]) {
			assert.throws(() => clients(`new Auth(stack, 'auth', { session: { ${session} } })`), /session\./, session);
		}
	});
});
