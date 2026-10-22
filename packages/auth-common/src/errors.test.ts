// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { ApiError } from '@aws-blocks/core';
import { type AuthErrorName, AuthErrors, isAuthError, isAuthErrorName } from './errors.js';

const canonicalNames: ReadonlySet<string> = new Set<string>(Object.values(AuthErrors));

// ─── The old-name → canonical-name mapping table ─────────────────────────────
//
// Every error name the three existing auth BBs throw or export today, and the
// canonical `AuthErrors` name that replaces it. This is a test + docs artifact
// only: no runtime alias map is exported, so callers matching an old name do
// not keep matching after the switch. `DESIGN.md` mirrors this table.
//
// `change`:
//   - `unchanged` — the old name is already canonical.
//   - `renamed`   — one old name becomes one different canonical name.
//   - `split`     — one old name becomes several canonical names. Every
//                   `isBlocksError` / `hasAuthError` call site matching the old
//                   name needs manual review: there is no mechanical rename.
//   - `excluded`  — deliberately outside the vocabulary (see `reason`).

type Source = 'AuthBasic' | 'AuthCognito' | 'AuthOIDC';

type MappingRow =
	| {
			source: Source;
			/** Key in the block's `*Errors` constant, or `null` for a name thrown as a literal. */
			constant: string | null;
			name: string;
			change: 'unchanged' | 'renamed' | 'split';
			canonical: readonly AuthErrorName[];
			note?: string;
	  }
	| {
			source: Source;
			constant: null;
			name: string;
			change: 'excluded';
			reason: string;
	  };

const cognito = (constant: keyof typeof AuthErrors, name: AuthErrorName): MappingRow => ({
	source: 'AuthCognito',
	constant,
	name,
	change: 'unchanged',
	canonical: [name],
});
const oidc = (constant: keyof typeof AuthErrors, name: AuthErrorName): MappingRow => ({
	source: 'AuthOIDC',
	constant,
	name,
	change: 'unchanged',
	canonical: [name],
});

/**
 * AWS rejecting the *function's own* credentials or IAM policy when it calls
 * Cognito. A deployment problem, not an auth outcome: `AuthCognito` reports it
 * by its AWS name as a 500 with a generic message, and logs the detail.
 */
const AWS_ACCESS_FAILURE =
	'AWS SDK credential / IAM failure of the function role, not an auth outcome. AuthCognito passes it ' +
	'through by name as a 500 with a generic message (the SDK message names the role ARN and account id).';

const MAPPING: readonly MappingRow[] = [
	// ── AuthBasic — `AuthBasicErrors` ────────────────────────────────────────
	{
		source: 'AuthBasic',
		constant: 'InvalidCredentials',
		name: 'InvalidCredentialsException',
		change: 'renamed',
		canonical: [AuthErrors.NotAuthorized],
		note: 'same condition; Cognito wire name wins',
	},
	{
		source: 'AuthBasic',
		constant: 'UserAlreadyExists',
		name: 'UserAlreadyExistsException',
		change: 'renamed',
		canonical: [AuthErrors.UserAlreadyExists],
		note: 'key kept, value changes to the Cognito wire name',
	},
	{
		source: 'AuthBasic',
		constant: 'InvalidCode',
		name: 'InvalidCodeException',
		change: 'split',
		canonical: [AuthErrors.CodeMismatch, AuthErrors.ExpiredCode],
		note: 'wrong code → CodeMismatch; expired or no outstanding code → ExpiredCode. Review every call site.',
	},
	{
		source: 'AuthBasic',
		constant: 'SessionExpired',
		name: 'SessionExpiredException',
		change: 'renamed',
		canonical: [AuthErrors.NotAuthenticated],
		note: 'the 401 name Cognito and OIDC already throw',
	},
	{
		source: 'AuthBasic',
		constant: 'InvalidPassword',
		name: 'InvalidPasswordException',
		change: 'unchanged',
		canonical: [AuthErrors.InvalidPassword],
	},

	// ── AuthCognito — `AuthCognitoErrors` (all 29 kept verbatim: keys and values) ──
	cognito('NotAuthenticated', 'NotAuthenticatedException'),
	cognito('NotAuthorized', 'NotAuthorizedException'),
	cognito('UserNotFound', 'UserNotFoundException'),
	cognito('UserAlreadyExists', 'UsernameExistsException'),
	cognito('InvalidPassword', 'InvalidPasswordException'),
	cognito('InvalidParameter', 'InvalidParameterException'),
	cognito('CodeMismatch', 'CodeMismatchException'),
	cognito('ExpiredCode', 'ExpiredCodeException'),
	cognito('LimitExceeded', 'LimitExceededException'),
	cognito('TooManyRequests', 'TooManyRequestsException'),
	cognito('TooManyFailedAttempts', 'TooManyFailedAttemptsException'),
	cognito('PasswordResetRequired', 'PasswordResetRequiredException'),
	cognito('UserNotConfirmed', 'UserNotConfirmedException'),
	cognito('MFAMethodNotFound', 'MFAMethodNotFoundException'),
	cognito('SoftwareTokenMFANotFound', 'SoftwareTokenMFANotFoundException'),
	cognito('GroupNotFound', 'ResourceNotFoundException'),
	cognito('UnsupportedUserState', 'UnsupportedUserStateException'),
	cognito('AliasExists', 'AliasExistsException'),
	cognito('InvalidLambdaResponse', 'InvalidLambdaResponseException'),
	cognito('UserLambdaValidation', 'UserLambdaValidationException'),
	cognito('InternalError', 'InternalErrorException'),
	cognito('EnableSoftwareTokenMFA', 'EnableSoftwareTokenMFAException'),
	cognito('WebAuthnNotEnabled', 'WebAuthnNotEnabledException'),
	cognito('WebAuthnOriginNotAllowed', 'WebAuthnOriginNotAllowedException'),
	cognito('WebAuthnRelyingPartyMismatch', 'WebAuthnRelyingPartyMismatchException'),
	cognito('WebAuthnChallengeNotFound', 'WebAuthnChallengeNotFoundException'),
	cognito('WebAuthnCredentialNotSupported', 'WebAuthnCredentialNotSupportedException'),
	cognito('WebAuthnClientMismatch', 'WebAuthnClientMismatchException'),
	cognito('WebAuthnConfigurationMissing', 'WebAuthnConfigurationMissingException'),

	// ── AuthOIDC — `AuthOIDCErrors` (all 8 kept) ──────────────────────────────
	oidc('NotAuthenticated', 'NotAuthenticatedException'),
	oidc('TokenExpired', 'TokenExpiredException'),
	oidc('InvalidState', 'InvalidStateException'),
	oidc('InvalidCallback', 'InvalidCallbackException'),
	oidc('ProviderNotConfigured', 'ProviderNotConfiguredException'),
	oidc('IdpError', 'IdpErrorException'),
	oidc('InvalidRelay', 'InvalidRelayException'),
	oidc('SdkOutdated', 'SdkOutdatedException'),

	// ── AuthOIDC — names set on plain `Error`s, outside `AuthOIDCErrors` ──────
	{
		source: 'AuthOIDC',
		constant: null,
		name: 'AuthOIDCEngineError',
		change: 'split',
		canonical: [
			AuthErrors.ProviderNotConfigured,
			AuthErrors.InvalidState,
			AuthErrors.InvalidCallback,
			AuthErrors.IdpError,
			AuthErrors.TokenExpired,
		],
		note:
			'cognito-federation engine: provider not configured → ProviderNotConfigured; missing/invalid ' +
			'pending cookie or state mismatch → InvalidState; missing code → InvalidCallback; token ' +
			'exchange failed → IdpError; refresh failed / no refresh token → TokenExpired',
	},
	{
		source: 'AuthOIDC',
		constant: null,
		name: 'AuthOIDCConfigError',
		change: 'excluded',
		reason:
			'constructor-time configuration mistake (bad provider config, postSignInPath). Per ' +
			'bb-auth-basic D-AB-10, configuration errors stay plain Errors with no constant to branch on.',
	},
	{
		source: 'AuthOIDC',
		constant: null,
		name: 'RelayConfigError',
		change: 'excluded',
		reason: 'constructor-time `relayOrigin` configuration mistake; plain Error per D-AB-10.',
	},
	{
		source: 'AuthOIDC',
		constant: null,
		name: 'DuplicateProviderException',
		change: 'excluded',
		reason:
			'Cognito SDK error caught and swallowed inside the IdP-registration custom-resource Lambda; ' +
			'never surfaced to an app.',
	},
	{
		source: 'AuthOIDC',
		constant: null,
		name: 'ResourceNotFoundException',
		change: 'excluded',
		reason:
			'Cognito SDK error caught and swallowed inside the IdP-registration custom-resource Lambda; ' +
			'never surfaced to an app. (Coincides with `AuthErrors.GroupNotFound`, which is unrelated.)',
	},
	{
		source: 'AuthCognito',
		constant: null,
		name: 'AccessDeniedException',
		change: 'excluded',
		reason: AWS_ACCESS_FAILURE,
	},
	{
		source: 'AuthCognito',
		constant: null,
		name: 'UnrecognizedClientException',
		change: 'excluded',
		reason: AWS_ACCESS_FAILURE,
	},
	{
		source: 'AuthCognito',
		constant: null,
		name: 'InvalidSignatureException',
		change: 'excluded',
		reason: AWS_ACCESS_FAILURE,
	},
	{
		source: 'AuthCognito',
		constant: null,
		name: 'ExpiredTokenException',
		change: 'excluded',
		reason: AWS_ACCESS_FAILURE,
	},
	{
		source: 'AuthCognito',
		constant: null,
		name: 'CredentialsProviderError',
		change: 'excluded',
		reason: AWS_ACCESS_FAILURE,
	},
];

/** The only names allowed outside the vocabulary. Adding one is a deliberate decision. */
const EXPECTED_EXCLUSIONS = [
	'AuthOIDCConfigError',
	'RelayConfigError',
	'DuplicateProviderException',
	'ResourceNotFoundException',
	'AccessDeniedException',
	'UnrecognizedClientException',
	'InvalidSignatureException',
	'ExpiredTokenException',
	'CredentialsProviderError',
];

/**
 * Every quoted `…Exception` / `…Error` name literal in each replaced block's
 * non-test sources (every `.ts` file under `src/`, excluding `*.test.ts`,
 * `*.types-test.ts` and `test-support/`), as found by scanning them at the
 * cutover (F1b): bb-auth-basic 0.1.9, bb-auth-cognito 0.1.10 and bb-auth-oidc
 * 0.2.0, deleted then. Frozen; these blocks will never throw a new name.
 */
const NAMES_IN_SOURCES: Record<Source, readonly string[]> = {
	AuthBasic: [
		'InvalidCodeException',
		'InvalidCredentialsException',
		'InvalidPasswordException',
		'SessionExpiredException',
		'UserAlreadyExistsException',
	],
	AuthCognito: [
		'AccessDeniedException',
		'AliasExistsException',
		'CodeMismatchException',
		'CredentialsProviderError',
		'EnableSoftwareTokenMFAException',
		'ExpiredCodeException',
		'ExpiredTokenException',
		'InternalErrorException',
		'InvalidLambdaResponseException',
		'InvalidParameterException',
		'InvalidPasswordException',
		'InvalidSignatureException',
		'LimitExceededException',
		'MFAMethodNotFoundException',
		'NotAuthenticatedException',
		'NotAuthorizedException',
		'PasswordResetRequiredException',
		'ResourceNotFoundException',
		'SoftwareTokenMFANotFoundException',
		'TooManyFailedAttemptsException',
		'TooManyRequestsException',
		'UnrecognizedClientException',
		'UnsupportedUserStateException',
		'UserLambdaValidationException',
		'UserNotConfirmedException',
		'UserNotFoundException',
		'UsernameExistsException',
		'WebAuthnChallengeNotFoundException',
		'WebAuthnClientMismatchException',
		'WebAuthnConfigurationMissingException',
		'WebAuthnCredentialNotSupportedException',
		'WebAuthnNotEnabledException',
		'WebAuthnOriginNotAllowedException',
		'WebAuthnRelyingPartyMismatchException',
	],
	AuthOIDC: [
		'AuthOIDCConfigError',
		'AuthOIDCEngineError',
		'DuplicateProviderException',
		'IdpErrorException',
		'InvalidCallbackException',
		'InvalidRelayException',
		'InvalidStateException',
		'NotAuthenticatedException',
		'ProviderNotConfiguredException',
		'RelayConfigError',
		'ResourceNotFoundException',
		'SdkOutdatedException',
		'TokenExpiredException',
	],
};

describe('AuthErrors', () => {
	test('every value is unique', () => {
		const values = Object.values(AuthErrors);
		assert.strictEqual(new Set(values).size, values.length);
	});

	test('every value uses the `*Exception` suffix', () => {
		for (const value of Object.values(AuthErrors)) {
			assert.match(value, /^[A-Z][A-Za-z]+Exception$/, value);
		}
	});

	test('contains the names added for the unified Auth block', () => {
		assert.strictEqual(AuthErrors.ReauthenticationRequired, 'ReauthenticationRequiredException');
		assert.strictEqual(AuthErrors.ProviderMisconfigured, 'ProviderMisconfiguredException');
		assert.strictEqual(AuthErrors.EmailPasswordNotEnabled, 'EmailPasswordNotEnabledException');
		assert.strictEqual(AuthErrors.NoFederatedProvider, 'NoFederatedProviderException');
	});

	test('does not alias the replaced AuthBasic names', () => {
		for (const dropped of [
			'InvalidCredentialsException',
			'UserAlreadyExistsException',
			'InvalidCodeException',
			'SessionExpiredException',
		]) {
			assert.ok(!canonicalNames.has(dropped), `${dropped} must not be canonical`);
		}
	});
});

describe('isAuthError', () => {
	test('matches an ApiError by name (server side)', () => {
		const e = new ApiError('Authentication required', 401, { name: AuthErrors.NotAuthenticated });
		assert.strictEqual(isAuthError(e, AuthErrors.NotAuthenticated), true);
		assert.strictEqual(isAuthError(e, AuthErrors.NotAuthorized), false);
		assert.strictEqual(isAuthError(e), true);
	});

	test('matches an Error reconstructed from the wire (client side)', () => {
		// The client rebuilds thrown errors from `{ error, name }`; only the name survives.
		const e = new Error('Authentication required');
		e.name = 'NotAuthenticatedException';
		assert.strictEqual(isAuthError(e, AuthErrors.NotAuthenticated), true);
		assert.strictEqual(isAuthError(e), true);
	});

	test('rejects names outside the vocabulary and non-Error values', () => {
		const basic = new ApiError('Authentication required', 401, { name: 'SessionExpiredException' });
		assert.strictEqual(isAuthError(basic), false);
		assert.strictEqual(isAuthError(new ApiError('boom', 500)), false);
		assert.strictEqual(isAuthError({ name: AuthErrors.NotAuthenticated }), false);
		assert.strictEqual(isAuthError({ name: AuthErrors.NotAuthenticated }, AuthErrors.NotAuthenticated), false);
		assert.strictEqual(isAuthError(null), false);
		assert.strictEqual(isAuthError(AuthErrors.NotAuthenticated), false);
	});
});

describe('isAuthErrorName', () => {
	test('accepts every canonical name and nothing else', () => {
		for (const value of Object.values(AuthErrors)) assert.strictEqual(isAuthErrorName(value), true);
		assert.strictEqual(isAuthErrorName('SessionExpiredException'), false);
		assert.strictEqual(isAuthErrorName(undefined), false);
		assert.strictEqual(isAuthErrorName(401), false);
	});
});

describe('old-name → canonical mapping table', () => {
	test('every row maps to canonical AuthErrors members, or is a recorded exclusion', () => {
		for (const row of MAPPING) {
			const where = `${row.source} ${row.name}`;
			if (row.change === 'excluded') {
				assert.ok(EXPECTED_EXCLUSIONS.includes(row.name), `${where}: unexpected exclusion`);
				assert.ok(row.reason.length > 0, `${where}: exclusion needs a reason`);
				continue;
			}
			assert.ok(row.canonical.length > 0, `${where}: no canonical home`);
			for (const name of row.canonical) assert.ok(canonicalNames.has(name), `${where}: ${name} is not canonical`);
			if (row.change === 'unchanged') assert.deepStrictEqual(row.canonical, [row.name], where);
			if (row.change === 'renamed') {
				assert.strictEqual(row.canonical.length, 1, where);
				assert.notStrictEqual(row.canonical[0], row.name, where);
			}
			if (row.change === 'split') assert.ok(row.canonical.length >= 2, `${where}: a split needs 2+ names`);
		}
		assert.deepStrictEqual(
			MAPPING.filter((r) => r.change === 'excluded')
				.map((r) => r.name)
				.sort(),
			[...EXPECTED_EXCLUSIONS].sort(),
		);
	});

	test('Cognito keys and values carry over verbatim', () => {
		const rows = MAPPING.filter((r) => r.source === 'AuthCognito' && r.change !== 'excluded');
		assert.strictEqual(rows.length, 29);
		for (const row of rows) {
			const canonical = Object.entries(AuthErrors).find(([key]) => key === row.constant);
			assert.ok(canonical, `${row.constant}: key missing from AuthErrors`);
			assert.strictEqual(canonical[1], row.name);
		}
	});

	test('covers all five AuthBasicErrors and all eight AuthOIDCErrors', () => {
		const constants = (source: Source) =>
			MAPPING.filter((r) => r.source === source && r.constant !== null).map((r) => r.constant);
		assert.deepStrictEqual(constants('AuthBasic').sort(), [
			'InvalidCode',
			'InvalidCredentials',
			'InvalidPassword',
			'SessionExpired',
			'UserAlreadyExists',
		]);
		assert.strictEqual(constants('AuthOIDC').length, 8);
	});

	test('records InvalidCodeException as a split needing manual review', () => {
		const row = MAPPING.find((r) => r.name === 'InvalidCodeException');
		assert.ok(row && row.change === 'split');
		assert.deepStrictEqual([...row.canonical].sort(), [AuthErrors.CodeMismatch, AuthErrors.ExpiredCode].sort());
	});

	// The table must stay complete: every quoted `…Exception` / `…Error` name
	// literal in the three auth BBs' non-test sources needs a row. Until the
	// cutover this scanned those sources; they were deleted at F1b, so the
	// scan's result is frozen in NAMES_IN_SOURCES (same assertion, no scan).
	// (Names Cognito returns at runtime are passed through by `AuthCognito`
	// unchanged; the ones it declares are all in `AuthCognitoErrors`.)
	for (const [source, names] of Object.entries(NAMES_IN_SOURCES) as [Source, readonly string[]][]) {
		test(`every error name in the ${source} sources has a row`, () => {
			assert.ok(names.length > 0, `no error names recorded for ${source}`);
			const covered = new Set(MAPPING.filter((r) => r.source === source).map((r) => r.name));
			const missing = names.filter((n) => !covered.has(n));
			assert.deepStrictEqual(missing, [], `${source} throws names with no mapping row: ${missing.join(', ')}`);
		});
	}
});
