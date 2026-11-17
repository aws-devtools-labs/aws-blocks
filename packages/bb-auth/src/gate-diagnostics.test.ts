// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Asserts what the compiler *says* when a mode gate rejects a call.
 *
 * `types-test.ts` proves the gates reject the right calls, but
 * `@ts-expect-error` cannot check message text. The gate design depends on the
 * message: a gated method's rest parameter is named after the error, so the
 * editor shows e.g. "Arguments for the rest parameter
 * 'ERROR_emailPassword_is_disabled_on_this_Auth_instance' were not provided."
 * This test type-checks small probe programs against the built declarations
 * (`dist/index.mock.d.ts`, the package's `types` entry) with the TypeScript
 * compiler API and asserts on the diagnostic text.
 */

import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const compilerOptions: ts.CompilerOptions = {
	strict: true,
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.ES2022,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	skipLibCheck: true,
	noEmit: true,
	types: [],
};

const preamble = `
import type { BlocksContext, ScopeParent } from '@aws-blocks/core';
import { Auth } from './dist/index.mock.js';
declare const scope: ScopeParent;
declare const context: BlocksContext;
const okta = { issuer: 'https://dev-12345.okta.com', clientId: '0oa-okta' };
const oktaSecret = { fullId: 'okta-secret', get: async () => 's' };
export {};
`;

/** One probe program per case, all type-checked in a single compiler program. */
const probes = {
	valid: `
		const auth = new Auth(scope, 'ok', { providers: { okta: { type: 'oidc', ...okta, clientSecret: oktaSecret } } });
		void auth.signIn('alice', 'pw', context);
		void auth.getSignInUrl(context, 'okta');
	`,
	passwordOff: `
		const auth = new Auth(scope, 'off', { store: 'builtin', providers: { okta: { type: 'oidc', ...okta } } });
		void auth.signIn('alice', 'pw', context);
	`,
	passwordOffNoOptionals: `
		const auth = new Auth(scope, 'off', { store: 'builtin', providers: { okta: { type: 'oidc', ...okta } } });
		void auth.resendSignUpCode('alice');
	`,
	federationOff: `
		const auth = new Auth(scope, 'nofed', { users: { groups: ['admins'] } });
		void auth.getSignInUrl(context, 'okta' as never);
	`,
	mfaOff: `
		const auth = new Auth(scope, 'nomfa', { mfa: 'off' });
		void auth.setUpTotp(context);
	`,
	passkeysOff: `
		const auth = new Auth(scope, 'nopk', { passkeys: false });
		void auth.listPasskeys(context);
	`,
	adminActionOff: `
		const auth = new Auth(scope, 'adm', { admin: { actions: ['groups'] } });
		void auth.admin.createUser('u');
	`,
	adminOff: `
		const auth = new Auth(scope, 'noadm', { users: { groups: ['admins'] } });
		void auth.admin.createUser('u');
	`,
	adminOffNoArguments: `
		const auth = new Auth(scope, 'noadm', { users: { groups: ['admins'] } });
		void auth.admin.scan();
	`,
	zeroConfigAdmin: `
		const auth = new Auth(scope, 'zero');
		void auth.admin.createUser('u');
	`,
	builtinBearerObject: `
		new Auth(scope, 'bearer', {
			store: 'builtin',
			providers: { okta: { type: 'oidc', ...okta } },
			allowBearerAuth: { clientIds: ['c'] },
		});
	`,
	plainConstBuiltin: `
		const options = { store: 'builtin', providers: { okta: { type: 'oidc', ...okta } } };
		new Auth(scope, 'plain-builtin', options);
	`,
	plainConstCognito: `
		const options = { providers: { google: { type: 'google', clientId: 'g', clientSecret: oktaSecret } } };
		new Auth(scope, 'plain-cognito', options);
	`,
	builtinOptionMembers: `
		import type { BuiltinAuthMockOptions, BuiltinUserOptions } from './dist/index.mock.js';
		export declare const builtinOptions: BuiltinAuthMockOptions;
		export declare const builtinUsers: BuiltinUserOptions;
	`,
	mfaFactorNotInTypes: `
		const auth = new Auth(scope, 'totp', { mfa: { mode: 'optional', types: ['TOTP'] } });
		void auth.updateMfaPreference(context, { sms: 'ENABLED' });
	`,
} as const;
type ProbeName = keyof typeof probes;

const probeFile = (name: ProbeName): string => join(packageRoot, `__gate_probe_${name}__.ts`);

let diagnosticsByProbe: Map<ProbeName, string[]> | undefined;
let probeProgram: ts.Program | undefined;

/**
 * Type-check every probe once; return each diagnostic's full text (`TS<code>: <message>`), then one line
 * per related-information message.
 */
function diagnose(name: ProbeName): string[] {
	if (!diagnosticsByProbe) {
		const sources = new Map<string, string>(
			(Object.keys(probes) as ProbeName[]).map((n) => [probeFile(n), preamble + probes[n]]),
		);
		const host = ts.createCompilerHost(compilerOptions);
		const getSourceFile = host.getSourceFile.bind(host);
		const fileExists = host.fileExists.bind(host);
		const readFile = host.readFile.bind(host);
		host.getSourceFile = (fileName, languageVersion, ...rest) => {
			const source = sources.get(fileName);
			return source === undefined
				? getSourceFile(fileName, languageVersion, ...rest)
				: ts.createSourceFile(fileName, source, languageVersion, true);
		};
		host.fileExists = (fileName) => sources.has(fileName) || fileExists(fileName);
		host.readFile = (fileName) => sources.get(fileName) ?? readFile(fileName);

		const program = ts.createProgram([...sources.keys()], compilerOptions, host);
		probeProgram = program;
		diagnosticsByProbe = new Map(
			(Object.keys(probes) as ProbeName[]).map((n) => [
				n,
				ts
					.getPreEmitDiagnostics(program, program.getSourceFile(probeFile(n)))
					.map((d) =>
						[
							`TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`,
							...(d.relatedInformation ?? []).map((r) =>
								ts.flattenDiagnosticMessageText(r.messageText, '\n'),
							),
						].join('\n'),
					),
			]),
		);
	}
	return diagnosticsByProbe.get(name) ?? [];
}

describe('mode-gate diagnostics', () => {
	test('the probe harness compiles a valid program with no diagnostics', () => {
		// Guards the assertions below: if the harness itself failed to resolve
		// the package, every probe would "error" for the wrong reason.
		const diagnostics = diagnose('valid');
		assert.deepStrictEqual(diagnostics, []);
	});

	test('PasswordGate off: the diagnostic names the gate error', () => {
		const diagnostics = diagnose('passwordOff');
		assert.strictEqual(diagnostics.length, 1, diagnostics.join('\n---\n'));
		assert.match(diagnostics[0], /ERROR_emailPassword_is_disabled_on_this_Auth_instance/);
	});

	test('PasswordGate off: the exact two lines the README quotes (arity first, the cause in the related line)', () => {
		// A compiler limit (DESIGN.md, "Mode gates"): the first line is an arity
		// error and the gate's name is only in the related information. The
		// bb-auth README quotes these two lines verbatim; keep them in sync.
		assert.deepStrictEqual(diagnose('passwordOff'), [
			'TS2554: Expected 4 arguments, but got 3.\n' +
				"Arguments for the rest parameter 'ERROR_emailPassword_is_disabled_on_this_Auth_instance' were not provided.",
		]);
	});

	test('PasswordGate off: a gated method with no optional parameters names the gate error too', () => {
		const diagnostics = diagnose('passwordOffNoOptionals');
		assert.strictEqual(diagnostics.length, 1, diagnostics.join('\n---\n'));
		assert.match(diagnostics[0], /ERROR_emailPassword_is_disabled_on_this_Auth_instance/);
	});

	test('FederationGate off: the diagnostic names the gate error', () => {
		const diagnostics = diagnose('federationOff');
		assert.strictEqual(diagnostics.length, 1, diagnostics.join('\n---\n'));
		assert.match(diagnostics[0], /ERROR_no_federated_provider_is_configured/);
	});
	for (const [probe, gate] of [
		['mfaOff', 'ERROR_mfa_is_off_on_this_Auth_instance'],
		['passkeysOff', 'ERROR_passkeys_are_not_enabled_on_this_Auth_instance'],
		['adminActionOff', 'ERROR_admin_action_not_granted'],
		['adminOff', 'ERROR_admin_is_not_enabled__construct_Auth_with_admin_options'],
		['adminOffNoArguments', 'ERROR_admin_is_not_enabled__construct_Auth_with_admin_options'],
		['mfaFactorNotInTypes', 'ERROR_SMS_is_not_in_mfa_types'],
	] as const) {
		test(`${probe}: the diagnostic names the gate error`, () => {
			const diagnostics = diagnose(probe);
			assert.strictEqual(diagnostics.length, 1, diagnostics.join('\n---\n'));
			assert.match(diagnostics[0], new RegExp(gate));
		});
	}

	test('admin off: the diagnostic is a missing gate argument, not a missing property', () => {
		const [diagnostic] = diagnose('adminOff');
		assert.match(diagnostic, /Expected 2 arguments, but got 1/);
		assert.doesNotMatch(diagnostic, /does not exist on type/);
	});
});

describe('option diagnostics and completions', () => {
	test('zero-config `auth.admin` names the admin gate, not the builtin store', () => {
		// The wide getter is `AdminSurface | AdminDisabled`: with `AdminDisabledOnBuiltin` in the union too, which
		// member the compiler reported depended on program order.
		const diagnostics = diagnose('zeroConfigAdmin');
		assert.strictEqual(diagnostics.length, 1, diagnostics.join('\n---\n'));
		assert.match(diagnostics[0], /ERROR_admin_is_not_enabled__construct_Auth_with_admin_options/);
		assert.doesNotMatch(diagnostics[0], /ERROR_auth_admin_needs_store_cognito/);
	});

	test("`allowBearerAuth` as an object on a 'builtin' block names the store fix, not `boolean`", () => {
		const diagnostics = diagnose('builtinBearerObject');
		assert.strictEqual(diagnostics.length, 1, diagnostics.join('\n---\n'));
		assert.match(diagnostics[0], /ERROR_needs_store_cognito<"allowBearerAuth \(object form\)">/);
	});

	test('options in a plain `const` (no `as const`): the two messages the README troubleshooting note quotes', () => {
		const [builtin] = diagnose('plainConstBuiltin');
		assert.match(builtin, /Type 'string' is not assignable to type '"cognito"'/);
		const [cognito] = diagnose('plainConstCognito');
		assert.match(cognito, /Property 'issuer' is missing in type .* 'CognitoOidcProvider'/s);
	});

	test("every option a 'builtin' block refuses is `@deprecated` (sorts last in completions); `emailPassword` is not", () => {
		diagnose('valid');
		assert.ok(probeProgram);
		const checker = probeProgram.getTypeChecker();
		const source = probeProgram.getSourceFile(probeFile('builtinOptionMembers'));
		assert.ok(source);
		const exported = checker.getExportsOfModule(checker.getSymbolAtLocation(source) as ts.Symbol);
		const seen: string[] = [];
		for (const name of ['builtinOptions', 'builtinUsers']) {
			const symbol = exported.find((s) => s.name === name);
			assert.ok(symbol, name);
			const type = checker.getTypeOfSymbol(symbol);
			for (const prop of checker.getPropertiesOfType(type)) {
				const value = checker.getNonNullableType(checker.getTypeOfSymbol(prop));
				const members = value.isUnion() ? value.types : [value];
				const onlyErrors = members.every((m) => m.getProperty('__blocksOptionError') !== undefined);
				const deprecated = prop.getJsDocTags(checker).some((tag) => tag.name === 'deprecated');
				assert.strictEqual(
					deprecated,
					onlyErrors,
					`${name}.${prop.name}: @deprecated iff typed only as an error`,
				);
				if (deprecated) seen.push(`${name}.${prop.name}`);
			}
		}
		// Guards the walk itself: the refused options were found, and the legal `emailPassword: false` is not among them.
		for (const key of ['mfa', 'admin', 'userPool', 'codeDelivery', 'totpVerification', 'socialProviders']) {
			assert.ok(seen.includes(`builtinOptions.${key}`), key);
		}
		assert.ok(seen.includes('builtinUsers.signInWith'));
		assert.ok(!seen.includes('builtinOptions.emailPassword'));
		assert.ok(!seen.includes('builtinOptions.allowBearerAuth'));
	});
});
