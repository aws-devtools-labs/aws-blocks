/**
 * Synth of a `stubIdp()` provider (real CDK, `--conditions=cdk`): refused
 * outside a sandbox (CDK context `sandboxMode`, as `npm run sandbox` sets it)
 * and, in a sandbox, synthesized with a loud warning and the gateway URL the
 * deployed stub builds its issuer from.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { stubIdpConfigKeys } from './cdk/contract.js';
import { HARNESS_API_URL, synthUnderCdkConditions } from './test-support/cdk-synth.js';

const ALICE = "{ sub: 'u-1', email: 'alice@example.com', name: 'Alice', extra: { groups: ['admin'] } }";
const SANDBOX = { sandboxMode: 'true' };

function synth(construct: string, apiUrl?: string | null, context: Record<string, unknown> | undefined = SANDBOX) {
	return synthUnderCdkConditions({
		imports: "import { Auth, stubIdp } from '@aws-blocks/bb-auth';",
		build: `const auth = ${construct};\nreport.fullId = auth.fullId;`,
		apiUrl,
		context,
	});
}

describe('stubIdp() at synth on a sandbox deployment', () => {
	test('synthesizes, warns that anyone can sign in as the stub users, and registers the gateway URL', () => {
		const { template, config, report, warnings } = synth(
			`new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { corp: stubIdp({ users: [${ALICE}] }) } })`,
		);
		const fullId = String(report.fullId);
		const stubWarnings = warnings.filter((w) => w.message.includes('@aws-blocks/bb-auth:StubIdpDeployed'));
		assert.strictEqual(stubWarnings.length, 1, JSON.stringify(warnings));
		const [warning] = stubWarnings;
		assert.strictEqual(warning?.path, '/TestStack/auth');
		assert.match(warning?.message ?? '', /oidcProviders\.corp/);
		assert.match(
			warning?.message ?? '',
			/WITHOUT CREDENTIALS: anyone who can reach this sandbox can sign in as the stub's users/,
		);
		assert.match(warning?.message ?? '', /'alice@example\.com'/);
		assert.match(warning?.message ?? '', /Synth refuses it for any deployment that is not a sandbox/);

		assert.strictEqual(config[stubIdpConfigKeys(fullId).API_URL], HARNESS_API_URL);
		// Direct federation only: no user pool, as for any `emailPassword: false` + direct provider (Q6).
		assert.ok(!Object.values(template.Resources).some((r) => r.Type === 'AWS::Cognito::UserPool'));
	});

	test('the warning names the built-in default user when the stub has no users', () => {
		const { warnings } = synth(
			`new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { corp: stubIdp() } })`,
		);
		const warning = warnings.find((w) => w.message.includes('StubIdpDeployed'));
		assert.match(warning?.message ?? '', /its built-in default user \('corp-user@stub\.invalid'\)/);
	});

	test('no compute API URL fails the synth (the deployed issuer would otherwise come from the request Host)', () => {
		const construct = `new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { corp: stubIdp() } })`;
		const expected =
			/Auth '[^']+': oidcProviders\.corp is a stubIdp\(\) provider on a sandbox deployment, but the backend exposes no API URL/;
		// No stack compute at all …
		assert.throws(() => synth(construct, null), expected);
		// … and a compute that has no `apiUrl`.
		assert.throws(
			() =>
				synthUnderCdkConditions({
					imports: "import { Auth, stubIdp } from '@aws-blocks/bb-auth';",
					build: `stack._defaultCompute = {};\n${construct};`,
					apiUrl: null,
					context: SANDBOX,
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

	test('a sandbox synth with no stub needs no compute API URL either', () => {
		const { config, report } = synth(
			`new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { corp: { issuer: 'https://idp.example.com', clientId: 'c' } } })`,
			null,
		);
		assert.ok(!(stubIdpConfigKeys(String(report.fullId)).API_URL in config));
	});
});

describe('stubIdp() at synth outside a sandbox', () => {
	const expected =
		/Auth: oidcProviders\.corp is a stubIdp\(\) provider, which is only available in local development and sandbox deployments[\s\S]*getDeploymentType\(\)/;

	test('no sandboxMode context: refused before anything is provisioned', () => {
		assert.throws(
			() =>
				synth(
					`new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { corp: stubIdp() } })`,
					undefined,
					{},
				),
			expected,
		);
	});

	test("sandboxMode set to anything but 'true' / true: refused", () => {
		for (const sandboxMode of ['false', false, 'yes', 1]) {
			assert.throws(
				() =>
					synth(
						`new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { corp: stubIdp() } })`,
						undefined,
						{ sandboxMode },
					),
				expected,
				String(sandboxMode),
			);
		}
	});

	test('a boolean `sandboxMode: true` context (cdk.json, setContext) counts as a sandbox', () => {
		const { warnings } = synth(
			`new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { corp: stubIdp() } })`,
			undefined,
			{ sandboxMode: true },
		);
		assert.ok(warnings.some((w) => w.message.includes('@aws-blocks/bb-auth:StubIdpDeployed')));
	});

	test('every stub provider is named, next to a real one', () => {
		assert.throws(
			() =>
				synth(
					`new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { a: stubIdp(), okta: { issuer: 'https://o.example.com', clientId: 'c' }, b: stubIdp() } })`,
					undefined,
					{},
				),
			/Auth: oidcProviders\.a, oidcProviders\.b are stubIdp\(\) providers, which are only available/,
		);
	});

	test('a deployed stack without a stub synthesizes as before', () => {
		const { config, report } = synth(
			`new Auth(stack, 'auth', { emailPassword: false, oidcProviders: { corp: { issuer: 'https://idp.example.com', clientId: 'c' } } })`,
			null,
			{},
		);
		assert.ok(!(stubIdpConfigKeys(String(report.fullId)).API_URL in config));
	});
});
