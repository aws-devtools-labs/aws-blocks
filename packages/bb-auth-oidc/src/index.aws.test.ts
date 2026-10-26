// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime guard: a deployed Lambda mounts stub IdP routes only when the CDK
 * layer recorded a sandbox deploy. This backs up the synth guard in index.cdk.ts
 * for an artifact built without it.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { clearRouteRegistry } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { AuthOIDC, google, stubIdp } from './index.aws.js';
import { sandboxFlagEnvVar } from './utils.js';

const ROOT: ScopeParent = { id: 'test-app' };
const flagFor = (id: string): string => sandboxFlagEnvVar(`${ROOT.id}-${id}`);

describe('AWS runtime: stub IdP is sandbox-only', () => {
	let savedFunctionName: string | undefined;

	beforeEach(() => {
		clearRouteRegistry();
		savedFunctionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
		process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-app-fn';
	});

	afterEach(() => {
		clearRouteRegistry();
		if (savedFunctionName === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
		else process.env.AWS_LAMBDA_FUNCTION_NAME = savedFunctionName;
	});

	test('refuses a stub provider in a deployed Lambda without the sandbox flag', () => {
		delete process.env[flagFor('prod')];
		assert.throws(
			() => new AuthOIDC(ROOT, 'prod', { providers: [stubIdp({ name: 'dev' })] }),
			/stubIdp\(\) provider 'dev' can only run locally or in a sandbox/,
		);
	});

	test('refuses a stub provider when the flag records a production deploy', () => {
		process.env[flagFor('prod-false')] = 'false';
		try {
			assert.throws(() => new AuthOIDC(ROOT, 'prod-false', { providers: [stubIdp({ name: 'dev' })] }), /can only run locally or in a sandbox/);
		} finally {
			delete process.env[flagFor('prod-false')];
		}
	});

	test('allows a stub provider in a sandbox deploy', () => {
		process.env[flagFor('sandbox')] = 'true';
		try {
			assert.doesNotThrow(() => new AuthOIDC(ROOT, 'sandbox', { providers: [stubIdp({ name: 'dev' })] }));
		} finally {
			delete process.env[flagFor('sandbox')];
		}
	});

	test('skips the check outside Lambda (client codegen imports this module)', () => {
		delete process.env.AWS_LAMBDA_FUNCTION_NAME;
		assert.doesNotThrow(() => new AuthOIDC(ROOT, 'codegen', { providers: [stubIdp({ name: 'dev' })] }));
	});

	test('real providers are unaffected in a deployed Lambda', () => {
		delete process.env[flagFor('google')];
		assert.doesNotThrow(
			() => new AuthOIDC(ROOT, 'google', { providers: [google({ clientId: async () => 'id', clientSecret: async () => 'secret' })] }),
		);
	});
});
