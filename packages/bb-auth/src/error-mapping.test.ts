// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The client-visible error policy (L10, B6): vocabulary-only names, no AWS
 * identifiers, no SDK metadata, a non-enumerable `cause`, enumeration masking.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { AuthErrors } from '@aws-blocks/auth-common';
import { ApiError } from '@aws-blocks/core';
import { WRONG_CODE_MESSAGE } from './enumeration.js';
import {
	ACCESS_DENIED_MESSAGE,
	CLIENT_ERROR_MESSAGES,
	clientMessageFor,
	INTERNAL_ERROR_MESSAGE,
	toAuthApiError,
	userPoolNotProvisioned,
	WITHHELD_MESSAGE,
} from './error-mapping.js';
import { isRetriableAuthError, statusForAuthError } from './errors.js';
import { captureLogger, sdkError } from './test-helpers.js';

const AUTH_NAMES = new Set<string>(Object.values(AuthErrors));
const ARN = 'arn:aws:iam::123456789012:role/app-ExecutionRole-ABC';

/** What a client receives: exactly what an `ApiError` serializes to. */
function wire(e: ApiError): string {
	return JSON.stringify({ ...e, name: e.name, message: e.message, status: e.status, retriable: e.retriable });
}

function assertClientSafe(e: ApiError): void {
	assert.ok(AUTH_NAMES.has(e.name), `name ${e.name} is an AuthErrors member`);
	assert.ok(!Object.keys(e).includes('cause'), 'cause is not enumerable');
	const json = `${wire(e)} ${JSON.stringify(e)}`;
	assert.ok(!json.includes('$metadata'), 'no SDK metadata');
	assert.ok(!json.includes('requestId'), 'no request id');
	assert.ok(!/arn:aws/.test(json), 'no ARN');
	assert.ok(!/\d{12}/.test(json), 'no account id');
}

describe('toAuthApiError', () => {
	test('a vocabulary name keeps its name, gets the mapped status and retriable flag, cause non-enumerable', () => {
		const { logger } = captureLogger();
		const raw = sdkError('CodeMismatchException', 'Invalid verification code provided, please try again.');
		const e = toAuthApiError(raw, logger);
		assert.strictEqual(e.name, AuthErrors.CodeMismatch);
		assert.strictEqual(e.status, 400);
		assert.strictEqual(e.retriable, true);
		assert.strictEqual(e.cause, raw, 'the original rides along server-side');
		assertClientSafe(e);
	});

	for (const [name, status] of [
		['UsernameExistsException', 409],
		['TooManyRequestsException', 429],
		['LimitExceededException', 429],
		['NotAuthorizedException', 401],
		['InvalidPasswordException', 400],
		['ResourceNotFoundException', 404],
	] as const) {
		test(`${name} → ${status}`, () => {
			const e = toAuthApiError(sdkError(name, 'x'), captureLogger().logger);
			assert.strictEqual(e.name, name);
			assert.strictEqual(e.status, status);
			assertClientSafe(e);
		});
	}

	test('L10: a name outside AuthErrors becomes InternalErrorException, 500, retriable; the detail is logged only', () => {
		const { logger, entries } = captureLogger();
		for (const raw of [
			sdkError('CodeDeliveryFailureException', 'Unable to deliver to +15555550100'),
			new TypeError('Cannot read properties of undefined'),
			sdkError('SomeFutureCognitoException', 'details'),
		]) {
			const e = toAuthApiError(raw, logger);
			assert.strictEqual(e.name, AuthErrors.InternalError);
			assert.strictEqual(e.status, 500);
			assert.strictEqual(e.retriable, true);
			assert.strictEqual(e.message, INTERNAL_ERROR_MESSAGE);
			assertClientSafe(e);
			assert.ok(!e.message.includes(raw.message));
		}
		assert.deepStrictEqual(
			entries.map((x) => x.context?.error),
			['CodeDeliveryFailureException', 'TypeError', 'SomeFutureCognitoException'],
		);
	});

	test('a non-Error throw becomes InternalError', () => {
		const e = toAuthApiError('a string', captureLogger().logger);
		assert.strictEqual(e.name, AuthErrors.InternalError);
		assertClientSafe(e);
	});

	test('AWS access errors never reach the client: generic message, InternalError, detail logged', () => {
		const { logger, entries } = captureLogger();
		const raw = sdkError(
			'AccessDeniedException',
			`User: ${ARN} is not authorized to perform: cognito-idp:AdminListGroupsForUser on resource: arn:aws:cognito-idp:us-east-1:123456789012:userpool/x`,
		);
		const e = toAuthApiError(raw, logger);
		assert.strictEqual(e.message, ACCESS_DENIED_MESSAGE);
		assert.strictEqual(e.name, AuthErrors.InternalError);
		assert.strictEqual(e.status, 500);
		assertClientSafe(e);
		assert.ok(String(entries[0]?.context?.message).includes(ARN), 'operators still get the ARN');
	});

	test('a vocabulary error whose message names an ARN or account id is withheld; the detail is logged at error', () => {
		for (const message of [`Role ${ARN} cannot do that`, 'Account 123456789012 is over its limit']) {
			const { logger, entries } = captureLogger();
			const e = toAuthApiError(sdkError('LimitExceededException', message), logger);
			// FX59: every engine error now gets its name's fixed message (#678),
			// not only the ones that name AWS resources.
			assert.strictEqual(e.message, clientMessageFor(AuthErrors.LimitExceeded));
			assert.strictEqual(e.name, AuthErrors.LimitExceeded);
			assertClientSafe(e);
			assert.ok(
				entries.some((x) => x.level === 'error' && x.context?.message === message),
				'operators still get the AWS detail',
			);
		}
	});

	test('an ApiError raised on purpose passes through (name, status, retriable), its message still scrubbed', () => {
		const mine = new ApiError('Corporate accounts only', 403, { name: AuthErrors.NotAuthorized });
		assert.strictEqual(toAuthApiError(mine, captureLogger().logger), mine);
		const leaky = new ApiError(`denied for ${ARN}`, 403, { name: AuthErrors.NotAuthorized, retriable: true });
		const scrubbed = toAuthApiError(leaky, captureLogger().logger);
		assert.strictEqual(scrubbed.message, WITHHELD_MESSAGE);
		assert.strictEqual(scrubbed.status, 403);
		assert.strictEqual(scrubbed.retriable, true);
		assertClientSafe(scrubbed);
	});

	test('flow signIn: unknown user / any NotAuthorized → the uniform credential failure', () => {
		const { logger, entries } = captureLogger();
		const shapes = [
			sdkError('UserNotFoundException', 'User does not exist.'),
			sdkError('NotAuthorizedException', 'Incorrect username or password.'),
			sdkError('NotAuthorizedException', 'User is disabled.'),
		].map((raw) => {
			const e = toAuthApiError(raw, logger, 'signIn');
			assertClientSafe(e);
			return JSON.stringify([e.name, e.status, e.message, e.retriable]);
		});
		assert.strictEqual(new Set(shapes).size, 1);
		assert.strictEqual(
			shapes[0],
			JSON.stringify([AuthErrors.NotAuthorized, 401, 'Incorrect username or password', false]),
		);
		assert.strictEqual(entries.length, 1, 'the disabled-user reason is logged for operators');
	});

	test('flow challenge: a vanished user → uniform credential failure; flow confirmCode: → wrong code', () => {
		const gone = sdkError('UserNotFoundException', 'User does not exist.');
		assert.strictEqual(toAuthApiError(gone, captureLogger().logger, 'challenge').name, AuthErrors.NotAuthorized);
		const code = toAuthApiError(gone, captureLogger().logger, 'confirmCode');
		assert.deepStrictEqual([code.name, code.status, code.retriable], [AuthErrors.CodeMismatch, 400, true]);
	});

	test('without a flow, UserNotFound keeps its name (admin paths only)', () => {
		const e = toAuthApiError(sdkError('UserNotFoundException', 'User does not exist.'), captureLogger().logger);
		assert.deepStrictEqual([e.name, e.status], [AuthErrors.UserNotFound, 404]);
	});

	test('userPoolNotProvisioned: a generic client error, the actionable detail in the log', () => {
		const { logger, entries } = captureLogger();
		const e = userPoolNotProvisioned('app-auth', logger);
		assert.strictEqual(e.name, AuthErrors.InternalError);
		assert.strictEqual(e.status, 500);
		assert.ok(!e.message.includes('app-auth'));
		assert.match(entries[0]?.message ?? '', /app-auth.*user pool/);
	});
});

describe('wire-safe messages: Cognito text never reaches a client (FX59, ports bb-auth-cognito #678)', () => {
	/** Cognito-shaped text that must stay server-side: an ARN, an account id, an endpoint, the user's login. */
	const RAW =
		'User: arn:aws:sts::123456789012:assumed-role/app-role/session is not authorized at ' +
		'https://cognito-idp.us-east-1.amazonaws.com for alice@example.com';

	test('every AuthErrors name has a BB-authored message that names nothing', () => {
		assert.deepStrictEqual(Object.keys(CLIENT_ERROR_MESSAGES).sort(), [...AUTH_NAMES].sort());
		for (const name of AUTH_NAMES) {
			const message = clientMessageFor(name);
			assert.ok(message.length > 0, `${name} has a message`);
			assert.doesNotMatch(message, /arn:|\d{12}|amazonaws|@/, `${name}: the fixed message names nothing`);
		}
	});

	test('an engine error with a vocabulary name gets its name’s fixed message, never its own text', () => {
		for (const name of AUTH_NAMES) {
			const raw = sdkError(name, RAW);
			const e = toAuthApiError(raw, captureLogger().logger);
			assert.strictEqual(e.name, name);
			assert.strictEqual(e.message, clientMessageFor(name), name);
			assert.strictEqual(e.status, statusForAuthError(name), name);
			assert.strictEqual(e.retriable, isRetriableAuthError(name), name);
			assert.ok(!wire(e).includes('alice@example.com'), `${name}: the login is not on the wire`);
			assert.ok(!wire(e).includes('amazonaws'), `${name}: no endpoint on the wire`);
			assertClientSafe(e);
		}
	});

	test('an ordinary Cognito message is replaced too (not only ones naming AWS resources)', () => {
		const e = toAuthApiError(
			sdkError('InvalidPasswordException', 'Password did not conform with policy: Password not long enough'),
			captureLogger().logger,
		);
		assert.strictEqual(e.message, clientMessageFor(AuthErrors.InvalidPassword));
		assert.ok(!e.message.includes('conform'));
	});

	test('the raw error stays server-side: non-enumerable cause, no own field of it copied', () => {
		const raw = Object.assign(sdkError(AuthErrors.NotAuthorized, RAW), { Code: 'NotAuthorizedException' });
		const e = toAuthApiError(raw, captureLogger().logger);
		assert.strictEqual(e.cause, raw);
		assert.strictEqual(Object.getOwnPropertyDescriptor(e, 'cause')?.enumerable, false);
		for (const key of Object.keys(raw).filter((k) => k !== 'name')) {
			assert.ok(!Object.keys(e).includes(key), `raw SDK field '${key}' was copied onto the ApiError`);
		}
		assert.ok(!JSON.stringify(e).includes('req-0000-1111'));
	});

	test('the raw text is logged, the login redacted (B6); nothing is logged when nothing was withheld', () => {
		const { logger, entries } = captureLogger();
		toAuthApiError(
			sdkError(AuthErrors.InvalidParameter, "1 validation error: username 'Alice@Example.com'"),
			logger,
			undefined,
			{
				login: 'alice@example.com',
			},
		);
		const line = entries.find((x) => x.context?.error === AuthErrors.InvalidParameter);
		assert.ok(line, `expected a log line: ${JSON.stringify(entries)}`);
		assert.strictEqual(line.level, 'info');
		assert.strictEqual(line.context?.message, "1 validation error: username '[REDACTED]'");
		assert.strictEqual(line.context?.requestId, 'req-0000-1111');

		const quiet = captureLogger();
		toAuthApiError(sdkError(AuthErrors.CodeMismatch, WRONG_CODE_MESSAGE), quiet.logger);
		assert.deepStrictEqual(quiet.entries, []);
	});

	test('FX60: the AWS-access and out-of-vocabulary log lines redact the login too', () => {
		const login = 'ada@example.com';
		// An unmapped name can quote the delivery destination; an access error echoes
		// the call it refused, which names the user it was made for.
		for (const raw of [
			sdkError('CodeDeliveryFailureException', `Unable to deliver the code to ${login}`),
			sdkError('AccessDeniedException', `User: ${ARN} is not authorized to perform: cognito-idp:AdminGetUser`),
			sdkError('AccessDeniedException', `User: ${ARN} may not read the profile of ${login}`),
		]) {
			const { logger, entries } = captureLogger();
			const e = toAuthApiError(raw, logger, undefined, { login });
			assertClientSafe(e);
			const line = entries.find((x) => x.context?.error === raw.name);
			assert.ok(line, `a log line for ${raw.name}: ${JSON.stringify(entries)}`);
			const message = String(line.context?.message);
			assert.ok(!message.includes(login), `the login is redacted from the log, got: ${message}`);
			assert.strictEqual(message, raw.message.replaceAll(login, '[REDACTED]'));
			// Redacting must not cost the operator the AWS detail they need.
			if (raw.message.includes(ARN)) assert.ok(message.includes(ARN), 'the ARN still reaches the operator');
		}
	});

	test('a service fault (5xx name) is logged at error', () => {
		const { logger, entries } = captureLogger();
		toAuthApiError(sdkError(AuthErrors.InternalError, 'Internal server error.', 500), logger);
		assert.strictEqual(entries[0]?.level, 'error');
		assert.strictEqual(entries[0]?.context?.message, 'Internal server error.');
	});

	test('a wrong code reads the same whether Cognito sent it or the enumeration masking did (FX3)', () => {
		const real = toAuthApiError(
			sdkError(AuthErrors.CodeMismatch, 'Invalid code received for user'),
			captureLogger().logger,
		);
		const masked = toAuthApiError(sdkError(AuthErrors.UserNotFound, RAW), captureLogger().logger, 'confirmCode');
		assert.strictEqual(real.message, WRONG_CODE_MESSAGE);
		assert.strictEqual(wire(real), wire(masked));
	});

	test('an ApiError raised on purpose keeps its BB- or app-authored message', () => {
		const mine = new ApiError('Corporate accounts only', 403, { name: AuthErrors.NotAuthorized });
		assert.strictEqual(toAuthApiError(mine, captureLogger().logger).message, 'Corporate accounts only');
	});

	test('a name outside the vocabulary still gets the generic internal-error message', () => {
		const e = toAuthApiError(sdkError('AccessDeniedException', RAW), captureLogger().logger);
		assert.strictEqual(e.message, ACCESS_DENIED_MESSAGE);
		const f = toAuthApiError(sdkError('SomeFutureCognitoException', RAW), captureLogger().logger);
		assert.strictEqual(f.message, INTERNAL_ERROR_MESSAGE);
	});
});

describe('status and retriable tables', () => {
	test('every AuthErrors name maps to a 4xx/5xx status', () => {
		for (const name of AUTH_NAMES) {
			const s = statusForAuthError(name);
			assert.ok(s >= 400 && s < 600, `${name} → ${s}`);
		}
		assert.strictEqual(statusForAuthError(AuthErrors.ReauthenticationRequired), 401);
		assert.strictEqual(statusForAuthError(AuthErrors.EmailPasswordNotEnabled), 409);
		assert.strictEqual(statusForAuthError(AuthErrors.NoFederatedProvider), 409);
		assert.strictEqual(statusForAuthError(AuthErrors.InternalError), 500);
	});

	test('retriable set is AuthCognito’s', () => {
		const retriable = [...AUTH_NAMES].filter(isRetriableAuthError).sort();
		assert.deepStrictEqual(
			retriable,
			[
				AuthErrors.CodeMismatch,
				AuthErrors.EnableSoftwareTokenMFA,
				AuthErrors.InternalError,
				AuthErrors.InvalidParameter,
				AuthErrors.InvalidPassword,
			].sort(),
		);
	});
});
