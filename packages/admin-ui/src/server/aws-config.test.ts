// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import {
	PROFILE_ENV_VAR,
	REGION_ENV_VAR,
	awsClientConfig,
	resetCredentialCache,
	resolveAmbientRegion,
	resolveProfile,
} from './aws-config.js';

// Next's types mark NODE_ENV readonly, so go through a widened view.
const env = process.env as Record<string, string | undefined>;

const TOUCHED = [PROFILE_ENV_VAR, REGION_ENV_VAR, 'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION'];
const saved = new Map<string, string | undefined>();
for (const name of TOUCHED) saved.set(name, env[name]);

function clearAll(): void {
	for (const name of TOUCHED) delete env[name];
}

afterEach(() => {
	for (const [name, value] of saved) {
		if (value === undefined) delete env[name];
		else env[name] = value;
	}
	resetCredentialCache();
});

describe('resolveProfile', () => {
	it('prefers the dashboard profile over AWS_PROFILE', () => {
		clearAll();
		env[PROFILE_ENV_VAR] = 'from-cli';
		env.AWS_PROFILE = 'from-shell';
		assert.strictEqual(resolveProfile(), 'from-cli');
	});

	it('falls back to AWS_PROFILE', () => {
		clearAll();
		env.AWS_PROFILE = 'from-shell';
		assert.strictEqual(resolveProfile(), 'from-shell');
	});

	it('is undefined when neither is set, so the ambient chain decides', () => {
		clearAll();
		assert.strictEqual(resolveProfile(), undefined);
	});

	it('treats a whitespace-only value as unset and falls through', () => {
		clearAll();
		env[PROFILE_ENV_VAR] = '   ';
		env.AWS_PROFILE = 'from-shell';
		assert.strictEqual(resolveProfile(), 'from-shell');
	});

	it('is undefined when every candidate is whitespace-only', () => {
		clearAll();
		env[PROFILE_ENV_VAR] = '  ';
		env.AWS_PROFILE = '\t';
		assert.strictEqual(resolveProfile(), undefined);
	});

	it('trims the resolved value', () => {
		clearAll();
		env[PROFILE_ENV_VAR] = '  padded  ';
		assert.strictEqual(resolveProfile(), 'padded');
	});
});

describe('resolveAmbientRegion', () => {
	it('prefers the dashboard region over both AWS variables', () => {
		clearAll();
		env[REGION_ENV_VAR] = 'eu-west-1';
		env.AWS_REGION = 'us-west-2';
		env.AWS_DEFAULT_REGION = 'ap-south-1';
		assert.strictEqual(resolveAmbientRegion(), 'eu-west-1');
	});

	it('prefers AWS_REGION over AWS_DEFAULT_REGION', () => {
		clearAll();
		env.AWS_REGION = 'us-west-2';
		env.AWS_DEFAULT_REGION = 'ap-south-1';
		assert.strictEqual(resolveAmbientRegion(), 'us-west-2');
	});

	it('honours AWS_DEFAULT_REGION alone — the AWS CLI writes it', () => {
		clearAll();
		env.AWS_DEFAULT_REGION = 'ap-south-1';
		assert.strictEqual(resolveAmbientRegion(), 'ap-south-1');
	});

	it('is undefined when no region variable is set', () => {
		clearAll();
		assert.strictEqual(resolveAmbientRegion(), undefined);
	});

	it('trims and skips whitespace-only values', () => {
		clearAll();
		env[REGION_ENV_VAR] = '  ';
		env.AWS_REGION = '  us-east-2 ';
		assert.strictEqual(resolveAmbientRegion(), 'us-east-2');
	});
});

describe('awsClientConfig region resolution', () => {
	it('lets an explicit region argument beat the ambient region', () => {
		clearAll();
		env[REGION_ENV_VAR] = 'eu-west-1';
		assert.strictEqual(awsClientConfig('us-east-1').region, 'us-east-1');
	});

	it('uses the ambient region when no argument is given', () => {
		clearAll();
		env.AWS_REGION = 'us-west-2';
		assert.strictEqual(awsClientConfig().region, 'us-west-2');
	});

	it('omits the region key entirely when nothing resolves, leaving SDK resolution intact', () => {
		clearAll();
		const config = awsClientConfig();
		assert.strictEqual('region' in config, false);
	});

	it('omits the region key when the argument is whitespace-only and no ambient region exists', () => {
		clearAll();
		const config = awsClientConfig('   ');
		assert.strictEqual('region' in config, false);
	});
});

describe('awsClientConfig credentials', () => {
	it('omits credentials when no profile is configured', () => {
		clearAll();
		const config = awsClientConfig('us-east-1');
		assert.strictEqual('credentials' in config, false);
	});

	it('supplies a credentials provider when a profile is configured', () => {
		clearAll();
		env[PROFILE_ENV_VAR] = 'blocks-dev';
		const config = awsClientConfig('us-east-1');
		// Shape only — resolving the provider would read ~/.aws and hit STS.
		assert.strictEqual(typeof config.credentials, 'function');
	});
});

describe('awsClientConfig credential memoization', () => {
	it('returns the identical provider reference for the same profile', () => {
		clearAll();
		env[PROFILE_ENV_VAR] = 'blocks-dev';
		const first = awsClientConfig().credentials;
		const second = awsClientConfig('us-east-1').credentials;
		assert.strictEqual(first, second);
	});

	it('returns a fresh provider after resetCredentialCache', () => {
		clearAll();
		env[PROFILE_ENV_VAR] = 'blocks-dev';
		const first = awsClientConfig().credentials;
		resetCredentialCache();
		const second = awsClientConfig().credentials;
		assert.notStrictEqual(first, second);
	});

	it('keeps separate providers per profile', () => {
		clearAll();
		env[PROFILE_ENV_VAR] = 'profile-a';
		const a = awsClientConfig().credentials;
		env[PROFILE_ENV_VAR] = 'profile-b';
		const b = awsClientConfig().credentials;
		assert.notStrictEqual(a, b);
	});
});
