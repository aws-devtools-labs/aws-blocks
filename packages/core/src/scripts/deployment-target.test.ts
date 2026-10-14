// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resolveDeploymentTarget } from './deployment-target.js';
import { assertAwsCredentials } from './preflight-credentials.js';

describe('resolveDeploymentTarget', () => {
	let home: string;
	let projectRoot: string;
	let env: NodeJS.ProcessEnv;
	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), 'blocks-cdk-target-'));
		projectRoot = join(home, 'project');
		await mkdir(projectRoot);
		await mkdir(join(home, '.aws'));
		await writeFile(join(home, '.aws', 'credentials'), '');
		await writeFile(
			join(home, '.aws', 'config'),
			'[default]\nregion=us-east-1\n[profile deployment]\nregion=eu-west-1\n',
		);
		env = { HOME: home };
	});
	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	it('uses the cdk.json profile and does not change env', async () => {
		await writeFile(join(projectRoot, 'cdk.json'), '{"profile":"deployment"}');
		assert.deepEqual(await resolveDeploymentTarget({ env, projectRoot }), {
			region: 'eu-west-1',
			profile: 'deployment',
		});
		await assertAwsCredentials({
			command: 'deploy',
			env,
			projectRoot,
			probe: async (region) => {
				assert.equal(region, 'eu-west-1');
			},
		});
		assert.deepEqual(env, { HOME: home });
	});

	it('uses ~/.cdk.json, and lets cdk.json override it', async () => {
		await writeFile(join(home, '.cdk.json'), '{"profile":"deployment", "region":"cn-north-1"}');
		env.AWS_REGION = 'us-east-2';
		assert.deepEqual(await resolveDeploymentTarget({ env, projectRoot }), {
			region: 'cn-north-1',
			profile: 'deployment',
		});
		await writeFile(join(projectRoot, 'cdk.json'), '{"profile":"default", "region":"us-gov-west-1"}');
		assert.deepEqual(await resolveDeploymentTarget({ env, projectRoot }), {
			region: 'us-gov-west-1',
			profile: 'default',
		});
		assert.equal(env.AWS_REGION, 'us-east-2');
	});

	it('uses AWS_REGION before the Region of the cdk.json profile', async () => {
		await writeFile(join(projectRoot, 'cdk.json'), '{"profile":"deployment"}');
		env.AWS_REGION = 'cn-north-1';
		env.AWS_PROFILE = 'default';
		assert.deepEqual(await resolveDeploymentTarget({ env, projectRoot }), {
			region: 'cn-north-1',
			profile: 'deployment',
		});
	});

	it('reads the AMAZON Region variables in the CDK order', async () => {
		const regionFor = async () => (await resolveDeploymentTarget({ env, projectRoot })).region;
		env.AMAZON_DEFAULT_REGION = 'ap-south-1';
		assert.equal(await regionFor(), 'ap-south-1');
		env.AWS_DEFAULT_REGION = 'us-east-2';
		assert.equal(await regionFor(), 'us-east-2');
		env.AMAZON_REGION = 'eu-west-1';
		assert.equal(await regionFor(), 'eu-west-1');
		env.AWS_REGION = 'cn-north-1';
		assert.equal(await regionFor(), 'cn-north-1');
	});

	it('selects AWS_DEFAULT_PROFILE after AWS_PROFILE, as CDK does', async () => {
		env.AWS_DEFAULT_PROFILE = 'deployment';
		assert.deepEqual(await resolveDeploymentTarget({ env, projectRoot }), {
			region: 'eu-west-1',
			profile: 'deployment',
		});
		// The SDK does not read AWS_DEFAULT_PROFILE, but CDK uses environment keys first.
		assert.deepEqual(
			await resolveDeploymentTarget({
				env: { ...env, AWS_ACCESS_KEY_ID: 'id', AWS_SECRET_ACCESS_KEY: 'key' },
				projectRoot,
			}),
			{ region: 'eu-west-1', profile: undefined },
		);
		assert.deepEqual(await resolveDeploymentTarget({ env: { ...env, AWS_PROFILE: 'default' }, projectRoot }), {
			region: 'us-east-1',
			profile: undefined,
		});
	});

	it('ignores context entries and CDK_DEFAULT_REGION', async () => {
		await writeFile(join(projectRoot, 'cdk.json'), '{"context":{"region":"eu-west-3","profile":"deployment"}}');
		env.CDK_DEFAULT_REGION = 'ap-south-1';
		assert.deepEqual(await resolveDeploymentTarget({ env, projectRoot }), {
			region: 'us-east-1',
			profile: undefined,
		});
	});

	it('reads Regions from absolute AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE paths', async () => {
		await writeFile(join(home, 'custom-config'), '[default]\nregion=eu-west-1\n');
		await writeFile(join(home, 'custom-credentials'), '[default]\nregion=eu-north-1\n');
		assert.equal(
			(
				await resolveDeploymentTarget({
					projectRoot,
					env: {
						...env,
						AWS_CONFIG_FILE: join(home, 'custom-config'),
						AWS_SHARED_CREDENTIALS_FILE: join(home, 'custom-credentials'),
					},
				})
			).region,
			'eu-north-1',
		);
	});

	it('reports unreadable CDK settings without leaking their contents or paths', async () => {
		await writeFile(join(projectRoot, 'cdk.json'), '{private-fixture-content');
		await assert.rejects(
			() => resolveDeploymentTarget({ env, projectRoot }),
			(error: Error) => {
				assert.match(error.message, /Check cdk.json/);
				assert.doesNotMatch(error.message, /private-fixture-content|blocks-cdk-target/);
				return true;
			},
		);
	});
});
