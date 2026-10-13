// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertNotDeployedMock } from './runtime-guard.js';

describe('assertNotDeployedMock', () => {
	test('throws when AWS_LAMBDA_FUNCTION_NAME is set (deployed Lambda)', () => {
		const origFnName = process.env.AWS_LAMBDA_FUNCTION_NAME;
		const origExecEnv = process.env.AWS_EXECUTION_ENV;
		process.env.AWS_LAMBDA_FUNCTION_NAME = 'blocks-backend-handler';
		// Isolate the assertion to the function-name signal.
		delete process.env.AWS_EXECUTION_ENV;

		try {
			assert.throws(
				() => assertNotDeployedMock('bb-auth-oidc'),
				(err: Error) => {
					assert.ok(
						err.message.includes('loaded in a deployed environment'),
						`Expected deployed-mock error, got: ${err.message}`,
					);
					assert.ok(
						err.message.includes('aws-runtime'),
						`Expected the fix hint to mention aws-runtime, got: ${err.message}`,
					);
					return true;
				},
			);
		} finally {
			restoreEnv('AWS_LAMBDA_FUNCTION_NAME', origFnName);
			restoreEnv('AWS_EXECUTION_ENV', origExecEnv);
		}
	});

	test('throws when only AWS_EXECUTION_ENV is set (managed runtime)', () => {
		const origFnName = process.env.AWS_LAMBDA_FUNCTION_NAME;
		const origExecEnv = process.env.AWS_EXECUTION_ENV;
		delete process.env.AWS_LAMBDA_FUNCTION_NAME;
		process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs22.x';

		try {
			assert.throws(() => assertNotDeployedMock('bb-auth-cognito'), /deployed environment/);
		} finally {
			restoreEnv('AWS_LAMBDA_FUNCTION_NAME', origFnName);
			restoreEnv('AWS_EXECUTION_ENV', origExecEnv);
		}
	});

	test('is a no-op locally (neither Lambda env var set)', () => {
		const origFnName = process.env.AWS_LAMBDA_FUNCTION_NAME;
		const origExecEnv = process.env.AWS_EXECUTION_ENV;
		delete process.env.AWS_LAMBDA_FUNCTION_NAME;
		delete process.env.AWS_EXECUTION_ENV;

		try {
			assert.doesNotThrow(() => assertNotDeployedMock('bb-auth-oidc'));
		} finally {
			restoreEnv('AWS_LAMBDA_FUNCTION_NAME', origFnName);
			restoreEnv('AWS_EXECUTION_ENV', origExecEnv);
		}
	});
});

/** Restore an env var to its original value, deleting it when it was unset. */
function restoreEnv(key: string, original: string | undefined): void {
	if (original === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = original;
	}
}
