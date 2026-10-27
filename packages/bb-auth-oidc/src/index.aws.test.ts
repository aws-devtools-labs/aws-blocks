// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime guard: deployed compute mounts stub IdP routes only when the CDK
 * layer recorded a sandbox deploy. This backs up the synth guard in index.cdk.ts
 * for an artifact built without it. "Deployed" is core's compute-agnostic
 * signal (BLOCKS_CONFIG_BUCKET + BLOCKS_CONFIG_KEY), not a Lambda-only variable.
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
	const DEPLOYED_ENV = ['BLOCKS_CONFIG_BUCKET', 'BLOCKS_CONFIG_KEY', 'AWS_LAMBDA_FUNCTION_NAME'] as const;
	let saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		clearRouteRegistry();
		saved = Object.fromEntries(DEPLOYED_ENV.map((k) => [k, process.env[k]]));
		// Deployed compute as Blocks configures it: the runtime-config location is
		// stamped on every compute target, Lambda or not.
		process.env.BLOCKS_CONFIG_BUCKET = 'config-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'config.json';
		delete process.env.AWS_LAMBDA_FUNCTION_NAME;
	});

	afterEach(() => {
		clearRouteRegistry();
		for (const k of DEPLOYED_ENV) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	test('refuses a stub provider on deployed non-Lambda compute (AgentCore, ECS) without the sandbox flag', () => {
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

	test('refuses a stub provider in a deployed Lambda without the sandbox flag', () => {
		process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-app-fn';
		delete process.env[flagFor('lambda')];
		assert.throws(() => new AuthOIDC(ROOT, 'lambda', { providers: [stubIdp({ name: 'dev' })] }), /can only run locally or in a sandbox/);
	});

	test('skips the check outside deployed compute (local dev, client codegen)', () => {
		delete process.env.BLOCKS_CONFIG_BUCKET;
		delete process.env.BLOCKS_CONFIG_KEY;
		assert.doesNotThrow(() => new AuthOIDC(ROOT, 'codegen', { providers: [stubIdp({ name: 'dev' })] }));
	});

	test('real providers are unaffected on deployed compute', () => {
		delete process.env[flagFor('google')];
		assert.doesNotThrow(
			() => new AuthOIDC(ROOT, 'google', { providers: [google({ clientId: async () => 'id', clientSecret: async () => 'secret' })] }),
		);
	});
});
