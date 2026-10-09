// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synth of a `stubIdp()` provider (real CDK, `--conditions=cdk`): refused by
 * default, deployable only with `unsafeAllowDeployed: true` — and then with a
 * loud warning and the gateway URL the deployed stub builds its issuer from.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { stubIdpConfigKeys } from './cdk/contract.js';
import { HARNESS_API_URL, synthUnderCdkConditions } from './test-support/cdk-synth.js';

const ALICE = "{ sub: 'u-1', email: 'alice@example.com', name: 'Alice', extra: { groups: ['admin'] } }";

function synth(construct: string, apiUrl?: string | null) {
	return synthUnderCdkConditions({
		imports: "import { Auth, stubIdp } from '@aws-blocks/bb-auth';",
		build: `const auth = ${construct};\nreport.fullId = auth.fullId;`,
		apiUrl,
	});
}

describe('stubIdp({ unsafeAllowDeployed: true }) at synth', () => {
	test('synthesizes, warns that anyone can sign in as the stub users, and registers the gateway URL', () => {
		const { template, config, report, warnings } = synth(
			`new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { corp: stubIdp({ users: [${ALICE}], unsafeAllowDeployed: true }) } })`,
		);
		const fullId = String(report.fullId);
		const stubWarnings = warnings.filter((w) => w.message.includes('@aws-blocks/bb-auth:StubIdpDeployed'));
		assert.strictEqual(stubWarnings.length, 1, JSON.stringify(warnings));
		const [warning] = stubWarnings;
		assert.strictEqual(warning?.path, '/TestStack/auth');
		assert.match(warning?.message ?? '', /oidcProviders\.corp/);
		assert.match(
			warning?.message ?? '',
			/WITHOUT CREDENTIALS: anyone who can reach this app can sign in as the stub's users/,
		);
		assert.match(warning?.message ?? '', /'alice@example\.com'/);
		assert.match(warning?.message ?? '', /disposable test stack/);

		assert.strictEqual(config[stubIdpConfigKeys(fullId).API_URL], HARNESS_API_URL);
		// Direct federation only: no user pool, as for any `emailPassword: false` + direct provider (Q6).
		assert.ok(!Object.values(template.Resources).some((r) => r.Type === 'AWS::Cognito::UserPool'));
	});

	test('the warning names the built-in default user when the stub has no users', () => {
		const { warnings } = synth(
			`new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { corp: stubIdp({ unsafeAllowDeployed: true }) } })`,
		);
		const warning = warnings.find((w) => w.message.includes('StubIdpDeployed'));
		assert.match(warning?.message ?? '', /its built-in default user \('corp-user@stub\.invalid'\)/);
	});

	test('no compute API URL fails the synth (the deployed issuer would otherwise come from the request Host)', () => {
		const construct = `new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { corp: stubIdp({ unsafeAllowDeployed: true }) } })`;
		const expected =
			/Auth '[^']+': oidcProviders\.corp is a stubIdp\(\) provider deployed with `unsafeAllowDeployed: true`, but the block's compute exposes no API URL/;
		// No stack compute at all …
		assert.throws(() => synth(construct, null), expected);
		// … and a compute that has no `apiUrl`.
		assert.throws(
			() =>
				synthUnderCdkConditions({
					imports: "import { Auth, stubIdp } from '@aws-blocks/bb-auth';",
					build: `stack._defaultCompute = {};\n${construct};`,
					apiUrl: null,
				}),
			expected,
		);
	});

	test('a deployed stack without a stub needs no compute API URL', () => {
		const { config, report } = synth(
			`new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { corp: { issuer: 'https://idp.example.com', clientId: 'c' } } })`,
			null,
		);
		assert.ok(!(stubIdpConfigKeys(String(report.fullId)).API_URL in config));
	});

	test('a stub without the opt-in, next to one with it, still fails the synth', () => {
		assert.throws(
			() =>
				synth(
					`new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { a: stubIdp({ unsafeAllowDeployed: true }), b: stubIdp() } })`,
				),
			/oidcProviders\.b is a stubIdp\(\) provider[\s\S]*unsafeAllowDeployed: true/,
		);
	});

	test('`unsafeAllowDeployed: false` (or any non-true value) is the default: refused', () => {
		assert.throws(
			() =>
				synth(
					`new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { corp: stubIdp({ unsafeAllowDeployed: false }) } })`,
				),
			/`stubIdp\(\)` is local-only/,
		);
	});
});
