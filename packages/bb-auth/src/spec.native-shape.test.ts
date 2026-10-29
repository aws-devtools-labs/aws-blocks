// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the OpenRPC spec — and so every native client — gets from `Auth`
 * blocks configured differently (password only, TOTP required, SMS, passkeys
 * with `USER_AUTH`, `emailPassword: false` with an OIDC provider, password
 * plus a provider, declared groups and attributes):
 *
 * - The types `Auth` narrows by its mode options for TypeScript callers only
 *   (`@blocksCodegenDefaultTypeArgs`: `createApi()`'s `setAuthState` input
 *   and `AuthState`, `SignInNextStep`, `MfaPreference`, `MfaPreferenceInput`)
 *   are the same wide shape for every block, so they generate one native type.
 * - The signed-in user (`AuthenticatedUser<O>`) carries each block's own
 *   schema — its provider ids, groups and attributes. Blocks whose users have
 *   the same schema share the `AuthenticatedUser` component; a block whose user
 *   differs is described where it is used, so a native client never decodes
 *   one block's user with another's type.
 *
 * Generates the spec from the backend's TypeScript source, as
 * `blocks-generate-spec` does. Set `BLOCKS_NATIVE_SHAPE_SPEC` to a path to
 * keep it (to run a native generator on it).
 */

import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApiNamespace, Scope } from '@aws-blocks/core';
import { generateSpec } from '@aws-blocks/core/scripts';
import { Auth } from './index.mock.js';
import type { AuthOptions } from './types.js';

const okta = { issuer: 'https://okta.example.com', clientId: 'c' };
const passkeys = { relyingPartyId: 'example.com', origins: ['https://example.com'] };
/** The second block with a provider mounts its routes apart from the first's. */
const mixedRedirects = {
	callbackPath: '/aws-blocks/auth/mixed/callback',
	signOutPath: '/aws-blocks/auth/mixed/signout',
};

/** Each block's options, as the backend source spells them. */
const BLOCKS = {
	password: `{ emailPassword: true }`,
	totp: `{ mfa: { mode: 'required', types: ['TOTP'] } }`,
	sms: `{ mfa: { mode: 'optional', types: ['SMS'] } }`,
	passkey: `{ users: { authFlow: 'USER_AUTH' }, passkeys: ${JSON.stringify(passkeys)}, featurePlan: 'essentials' }`,
	federated: `{ emailPassword: false, oidcProviders: { okta: ${JSON.stringify(okta)} } }`,
	mixed: `{ oidcProviders: { okta: ${JSON.stringify(okta)} }, redirects: ${JSON.stringify(mixedRedirects)} }`,
	attributes: `{ users: { groups: ['admins'], attributes: [{ name: 'department' }] } }`,
} as const;
type Block = keyof typeof BLOCKS;
const NAMES = Object.keys(BLOCKS) as Block[];
/** The blocks with email + password, which have `signIn`. */
const PASSWORD_BLOCKS = NAMES.filter((b) => b !== 'federated');

/** The same options, as values for the in-process backend. */
const OPTIONS: Record<Block, AuthOptions> = {
	password: { emailPassword: true },
	totp: { mfa: { mode: 'required', types: ['TOTP'] } },
	sms: { mfa: { mode: 'optional', types: ['SMS'] } },
	passkey: { users: { authFlow: 'USER_AUTH' }, passkeys, featurePlan: 'essentials' },
	federated: { emailPassword: false, oidcProviders: { okta } },
	mixed: { oidcProviders: { okta }, redirects: mixedRedirects },
	attributes: { users: { groups: ['admins'], attributes: [{ name: 'department' }] } },
};

const BACKEND = `
import { ApiNamespace, Scope } from '@aws-blocks/core';
import { Auth, type MfaPreferenceInput } from '@aws-blocks/bb-auth';

const scope = new Scope('shape');
${NAMES.map((b) => `const ${b}Options = ${BLOCKS[b]} as const;\nconst ${b} = new Auth(scope, '${b}', ${b}Options);`).join('\n')}

${NAMES.map((b) => `export const ${b}Api = ${b}.createApi();`).join('\n')}

export const api = new ApiNamespace(scope, 'api', (context) => ({
${PASSWORD_BLOCKS.map((b) => `	async ${b}SignIn(username: string, pw: string) { return ${b}.signIn(username, pw, context); },`).join('\n')}
${NAMES.map((b) => `	async ${b}Me() { return ${b}.requireAuth(context); },`).join('\n')}
	async totpPreference() { return totp.getMfaPreference(context); },
	async smsPreference() { return sms.getMfaPreference(context); },
	async totpSetPreference(pref: MfaPreferenceInput<typeof totpOptions>) { await totp.updateMfaPreference(context, pref); return totp.getMfaPreference(context); },
	async smsSetPreference(pref: MfaPreferenceInput<typeof smsOptions>) { await sms.updateMfaPreference(context, pref); return sms.getMfaPreference(context); },
}));
`;

const METHODS = [
	...PASSWORD_BLOCKS.map((b) => `${b}SignIn`),
	...NAMES.map((b) => `${b}Me`),
	'totpPreference',
	'smsPreference',
	'totpSetPreference',
	'smsSetPreference',
];

function inProcessBackend(): Record<string, unknown> {
	const scope = new Scope('shape');
	const backend: Record<string, unknown> = {};
	for (const b of NAMES) backend[`${b}Api`] = new Auth(scope, b, OPTIONS[b]).createApi();
	const unused = async () => null;
	backend.api = new ApiNamespace(scope, 'api', () => Object.fromEntries(METHODS.map((m) => [m, unused])));
	return backend;
}

// Inside the package, so `@aws-blocks/*` resolve through the workspace's node_modules.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(packageRoot, '.spec-native-shape-'));
after(() => rmSync(dir, { recursive: true, force: true }));

type Spec = Awaited<ReturnType<typeof generateSpec>>;
type Schema = { $ref?: string; oneOf?: Schema[]; properties?: Record<string, Schema>; enum?: unknown[] };

async function spec(): Promise<Spec> {
	writeFileSync(
		join(dir, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true },
		}),
	);
	const backendPath = join(dir, 'index.ts');
	writeFileSync(backendPath, BACKEND);
	const generated = await generateSpec(backendPath, async () => inProcessBackend());
	const keep = process.env.BLOCKS_NATIVE_SHAPE_SPEC;
	if (keep) writeFileSync(keep, JSON.stringify(generated, null, 2));
	return generated;
}

describe('the OpenRPC spec of differently configured Auth blocks', () => {
	let generated: Spec;
	const method = (name: string) => {
		const m = generated.methods.find((x) => x.name === name);
		assert.ok(m, `${name} is in the spec`);
		return m;
	};
	/** `schema`, following a `$ref` into the components. */
	const resolve = (schema: unknown): Schema => {
		const s = schema as Schema;
		return s.$ref ? (generated.components?.schemas?.[s.$ref.split('/').pop() ?? ''] as Schema) : s;
	};
	const json = (v: unknown) => JSON.stringify(v);

	test('generates, with no two schemas under one name', async () => {
		generated = await spec();
	});

	test('every createApi() namespace has the same setAuthState and getAuthState: the full action union', () => {
		for (const m of ['setAuthState', 'getAuthState']) {
			const shapes = NAMES.map((b) => {
				const { name: _name, ...rest } = method(`${b}Api.${m}`);
				return json(rest);
			});
			assert.strictEqual(new Set(shapes).size, 1, `${NAMES.length} blocks, one ${m}`);
		}
		const actions = json(method('federatedApi.setAuthState').params[0]?.schema);
		for (const action of ['signIn', 'signInWithPasskey', 'listPasskeys', 'confirmSignIn', 'signOut']) {
			assert.ok(actions.includes(`"${action}"`), `the emailPassword: false block still lists ${action}`);
		}
		for (const challenge of ['code', 'mfaType', 'totpSetup', 'email', 'password', 'firstFactor', 'webauthn']) {
			assert.ok(actions.includes(`"${challenge}"`), `confirmSignIn keeps the ${challenge} challenge`);
		}
	});

	test('signIn results carry every sign-in step, for every block with email + password', () => {
		const nextSteps = PASSWORD_BLOCKS.map((b) => {
			const arms = resolve(method(`api.${b}SignIn`).result.schema).oneOf ?? [];
			const next = arms.find((arm) => arm.properties?.status?.enum?.[0] === 'continueSignIn');
			assert.ok(next?.properties?.nextStep, `${b}: a continueSignIn arm`);
			return json(next.properties.nextStep);
		});
		assert.strictEqual(new Set(nextSteps).size, 1, `${PASSWORD_BLOCKS.length} blocks, one nextStep shape`);
		for (const step of [
			'CONFIRM_SIGN_IN_WITH_SMS_CODE',
			'CONTINUE_SIGN_IN_WITH_TOTP_SETUP',
			'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP',
			'CONFIRM_SIGN_IN_WITH_WEB_AUTHN',
			'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION',
		]) {
			assert.ok(nextSteps[0]?.includes(`"${step}"`), `the password-only block's result keeps ${step}`);
		}
	});

	test("each block's signed-in user keeps its own provider ids and groups; only identical users share a component", () => {
		const user = (b: Block) => resolve(method(`api.${b}Me`).result.schema);
		const shared = NAMES.filter((b) => (method(`api.${b}Me`).result.schema as Schema).$ref);
		assert.deepStrictEqual(
			shared.sort(),
			['passkey', 'password', 'sms', 'totp'],
			'the blocks with only email + password and no declared groups share AuthenticatedUser',
		);
		const component = json(generated.components?.schemas?.AuthenticatedUser);
		for (const b of NAMES.filter((x) => !shared.includes(x))) {
			assert.notStrictEqual(json(user(b)), component, `${b}: its own user, described where it is used`);
		}
		const providers = (b: Block) => [...(user(b).properties?.signInProvider?.enum ?? [])].sort();
		for (const b of shared) assert.deepStrictEqual(providers(b), ['password'], b);
		assert.deepStrictEqual(providers('federated'), ['okta', 'password']);
		assert.deepStrictEqual(providers('mixed'), ['okta', 'password']);
		const groups = user('attributes').properties?.groups as { items?: Schema } | undefined;
		assert.deepStrictEqual(groups?.items?.enum, ['admins']);
	});

	test('MFA preferences list every factor, whatever mfa.types, in and out', () => {
		const out = ['totpPreference', 'smsPreference'].map((m) => json(resolve(method(`api.${m}`).result.schema)));
		assert.strictEqual(out[0], out[1]);
		for (const factor of ['SMS', 'TOTP', 'EMAIL']) assert.ok(out[0]?.includes(`"${factor}"`), factor);

		const input = ['totpSetPreference', 'smsSetPreference'].map((m) =>
			resolve(method(`api.${m}`).params[0]?.schema),
		);
		assert.strictEqual(json(input[0]), json(input[1]), 'updateMfaPreference input: one shape');
		assert.deepStrictEqual(Object.keys(input[0]?.properties ?? {}).sort(), ['email', 'sms', 'totp']);
	});
});
