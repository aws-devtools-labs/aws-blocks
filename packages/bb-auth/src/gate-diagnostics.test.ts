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
export {};
`;

/** One probe program per case, all type-checked in a single compiler program. */
const probes = {
	valid: `
		const auth = new Auth(scope, 'ok', { oidcProviders: { okta } });
		void auth.signIn('alice', 'pw', context);
		void auth.getSignInUrl(context, 'okta');
	`,
	passwordOff: `
		const auth = new Auth(scope, 'off', { emailPassword: false, oidcProviders: { okta } });
		void auth.signIn('alice', 'pw', context);
	`,
	passwordOffNoOptionals: `
		const auth = new Auth(scope, 'off', { emailPassword: false, oidcProviders: { okta } });
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
} as const;
type ProbeName = keyof typeof probes;

const probeFile = (name: ProbeName): string => join(packageRoot, `__gate_probe_${name}__.ts`);

let diagnosticsByProbe: Map<ProbeName, string[]> | undefined;

/** Type-check every probe once; return each diagnostic's full text, related information included. */
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
		diagnosticsByProbe = new Map(
			(Object.keys(probes) as ProbeName[]).map((n) => [
				n,
				ts
					.getPreEmitDiagnostics(program, program.getSourceFile(probeFile(n)))
					.map((d) =>
						[
							ts.flattenDiagnosticMessageText(d.messageText, '\n'),
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
	] as const) {
		test(`${probe}: the diagnostic names the gate error`, () => {
			const diagnostics = diagnose(probe);
			assert.strictEqual(diagnostics.length, 1, diagnostics.join('\n---\n'));
			assert.match(diagnostics[0], new RegExp(gate));
		});
	}
});
