// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS-runtime security guard tests (CWE-798 / CWE-489 / CWE-290).
 *
 * The stub IdP forges identities with no real credential check, so its routes
 * must never be mounted in a deployed, non-sandbox app. `index.aws.ts` enforces
 * this at construction as defense-in-depth behind the CDK synth guard (see
 * index.cdk.test.ts). The guard fires only in a genuine deployed Lambda
 * (`AWS_LAMBDA_FUNCTION_NAME` present) so client-code generation, which imports
 * this module with no env, is never tripped.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { clearRouteRegistry } from '@aws-blocks/core';
import { AuthOIDC, google, stubIdp } from './index.aws.js';
import { sandboxFlagEnvVar } from './utils.js';

// A parentless root: `scopeFullId(ROOT, id)` resolves to `test-app-<id>`, so the
// sandbox flag env-var key is derived the same way the runtime derives it.
const ROOT = { id: 'test-app' } as any;
const sandboxKeyFor = (id: string): string => sandboxFlagEnvVar(`${ROOT.id}-${id}`);

describe('AWS runtime: stub IdP deploy guard', () => {
	// Snapshot the env we toggle so a test never leaks the deployed-runtime
	// signal into its neighbours or the rest of the suite.
	let savedFunctionName: string | undefined;

	beforeEach(() => {
		clearRouteRegistry();
		savedFunctionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
	});

	afterEach(() => {
		clearRouteRegistry();
		if (savedFunctionName === undefined) {
			delete process.env.AWS_LAMBDA_FUNCTION_NAME;
		} else {
			process.env.AWS_LAMBDA_FUNCTION_NAME = savedFunctionName;
		}
	});

	test('throws when a stub provider runs in a deployed (non-sandbox) Lambda', () => {
		const id = 'guard-prod';
		process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-app-fn';
		delete process.env[sandboxKeyFor(id)];
		assert.throws(
			() => new AuthOIDC(ROOT, id, { providers: [stubIdp({ name: 'dev' })] }),
			/stub IdP provider 'dev' cannot run in a deployed non-sandbox app/,
		);
	});

	test('allows a stub provider when the deploy is flagged sandbox', () => {
		const id = 'guard-sandbox';
		process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-app-fn';
		process.env[sandboxKeyFor(id)] = 'true';
		try {
			assert.doesNotThrow(
				() => new AuthOIDC(ROOT, id, { providers: [stubIdp({ name: 'dev' })] }),
			);
		} finally {
			delete process.env[sandboxKeyFor(id)];
		}
	});

	test('does NOT throw outside a deployed runtime (client codegen: no AWS_LAMBDA_FUNCTION_NAME)', () => {
		const id = 'guard-codegen';
		delete process.env.AWS_LAMBDA_FUNCTION_NAME;
		delete process.env[sandboxKeyFor(id)];
		assert.doesNotThrow(
			() => new AuthOIDC(ROOT, id, { providers: [stubIdp({ name: 'dev' })] }),
		);
	});

	test('a non-stub provider (google) is unaffected by the guard in a deployed runtime', () => {
		const id = 'guard-google';
		process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-app-fn';
		delete process.env[sandboxKeyFor(id)];
		assert.doesNotThrow(
			() => new AuthOIDC(ROOT, id, {
				providers: [google({ clientId: async () => 'id', clientSecret: async () => 'secret' })],
			}),
		);
	});
});
