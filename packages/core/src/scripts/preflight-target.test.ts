// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// Exercise real command ordering, env-file loading, preflight and ensureSecrets.
// Only AWS requests and process launch boundaries are replaced. A fresh process
// isolates SDK configuration caches and process.env from the developer's machine.
const scriptsUrl = new URL('./', import.meta.url).href;
function commandFixture(command: 'deploy' | 'sandbox', expectedRegion: string, explicitProfile?: string): string {
	return `
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';

const scripts = ${JSON.stringify(scriptsUrl)};
const moduleUrl = (name) => new URL(name + '.js', scripts).href;
const expectedRegion = ${JSON.stringify(expectedRegion)};
const explicitProfile = ${JSON.stringify(explicitProfile)};
const originalRegion = process.env.AWS_REGION;
const seen = [];
const stop = new Error('fixture stopped before CDK');

// Resolve these through the same import locations as the real callers. The
// SDK clients remain real; no credential provider or request is ever executed.
const { STSClient } = await import(${JSON.stringify(import.meta.resolve('@aws-sdk/client-sts'))});
const { SSMClient } = await import(${JSON.stringify(import.meta.resolve('@aws-sdk/client-ssm'))});
mock.method(STSClient.prototype, 'send', async function () {
  assert.equal(this.config.profile, explicitProfile);
  seen.push(['sts', await this.config.region()]);
  return { $metadata: {} };
});
mock.method(SSMClient.prototype, 'send', async function (command) {
  assert.equal(command.constructor.name, 'GetParameterCommand');
  assert.equal(this.config.profile, explicitProfile);
  seen.push(['ssm', await this.config.region()]);
  return { Parameter: { Value: 'fixture-connection' }, $metadata: {} };
});
mock.method(childProcess, 'execFileSync', () => Buffer.alloc(0));
syncBuiltinESMExports();

mock.module(moduleUrl('external-migrations-step'), {
  namedExports: { applyExternalMigrations: async () => {} },
});
mock.module(new URL('../telemetry/trackCommand.js', scripts).href, {
  namedExports: { trackCommand: async (_command, callback) => callback(), classifyError: () => ({}) },
});
mock.module(new URL('../telemetry/client.js', scripts).href, {
  namedExports: { buildAndSendEvent: () => {} },
});
const reachedCdk = (env) => {
  seen.push(['cdk']);
  assert.equal(env.AWS_REGION, originalRegion);
  assert.equal(env.AWS_CONFIG_FILE, process.env.AWS_CONFIG_FILE);
  assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, process.env.AWS_SHARED_CREDENTIALS_FILE);
  assert.equal(env.AWS_PROFILE, explicitProfile ? 'default' : 'deployment');
  assert.equal(env.CDK_DEFAULT_REGION, 'us-west-2');
  assert.equal(env.NODE_OPTIONS, '--conditions=cdk');
  throw stop;
};
const deployStream = await import(moduleUrl('deploy-stream'));
mock.module(moduleUrl('deploy-stream'), {
  namedExports: {
    ...deployStream,
    runStreaming: async (_command, _args, options) => reachedCdk(options.env),
  },
});
mock.module(moduleUrl('run-command'), {
  namedExports: {
    runSync: (_command, _args, options) => reachedCdk(options.env),
    spawnCommand: () => { throw new Error('unexpected watch process'); },
  },
});

const command = ${JSON.stringify(command)};
const run = command === 'deploy'
  ? () => import(moduleUrl('deploy')).then(({ deploy }) => deploy({ projectRoot: process.cwd(), cdkAppPath: 'unused' }))
  : () => import(moduleUrl('sandbox')).then(({ startSandbox }) => startSandbox({ backendPath: 'aws-blocks/index.cdk.ts', deployOnly: true }));
await assert.rejects(run, (error) => error === stop);
assert.deepEqual(seen, [['sts', expectedRegion], ['ssm', expectedRegion], ['cdk']]);
`;
}

describe('deploy/sandbox configured target', () => {
	for (const command of ['deploy', 'sandbox'] as const) {
		for (const source of ['profile', 'default-region', 'environment', 'cdk-profile', 'cdk-region'] as const) {
			it(`${command} resolves ${source} for STS and SSM without changing CDK's environment`, async () => {
				const directory = await mkdtemp(join(tmpdir(), 'blocks-target-'));
				try {
					await mkdir(join(directory, '.blocks'));
					await writeFile(join(directory, '.blocks', 'config.json'), '{"stackId":"fixture"}');
					await mkdir(join(directory, '.blocks-sandbox'));
					await writeFile(join(directory, '.blocks-sandbox', 'sandbox-id.txt'), 'fixture');
					const config = join(directory, 'config');
					const credentials = join(directory, 'credentials');
					// CDK prefers credentials-file Region; SDK normally prefers config.
					await writeFile(config, '[default]\nregion=us-east-1\n[profile deployment]\nregion=eu-west-1\n');
					await writeFile(credentials, '[deployment]\nregion=cn-north-1\n');
					if (source === 'cdk-profile')
						await writeFile(join(directory, 'cdk.json'), '{"profile":"deployment"}');
					if (source === 'cdk-region')
						await writeFile(join(directory, 'cdk.json'), '{"region":"eu-north-1"}');
					await writeFile(
						join(directory, command === 'deploy' ? '.env.production' : '.env.local'),
						`AWS_PROFILE=${source === 'cdk-profile' ? 'default' : 'deployment'}\nFIXTURE_DB_URL=fixture-connection\n${source === 'profile' || source === 'cdk-profile' ? '' : 'AWS_DEFAULT_REGION=us-gov-west-1\n'}`,
					);
					const env: NodeJS.ProcessEnv = {
						PATH: process.env.PATH,
						HOME: directory,
						USERPROFILE: directory,
						AWS_CONFIG_FILE: config,
						AWS_SHARED_CREDENTIALS_FILE: credentials,
						AWS_EC2_METADATA_DISABLED: 'true',
						AWS_BLOCKS_DISABLE_TELEMETRY: '1',
						CDK_DISABLE_CLI_TELEMETRY: 'true',
						CDK_DEFAULT_REGION: 'us-west-2',
					};
					if (source === 'environment') env.AWS_REGION = 'ap-south-1';
					const expected = {
						profile: 'cn-north-1',
						'default-region': 'us-gov-west-1',
						environment: 'ap-south-1',
						'cdk-profile': 'cn-north-1',
						'cdk-region': 'eu-north-1',
					}[source];
					assert.doesNotThrow(() =>
						execFileSync(
							process.execPath,
							[
								'--experimental-test-module-mocks',
								'--input-type=module',
								'-e',
								commandFixture(command, expected, source === 'cdk-profile' ? 'deployment' : undefined),
							],
							{ cwd: directory, env, encoding: 'utf8', stdio: 'pipe', timeout: 15_000 },
						),
					);
				} finally {
					await rm(directory, { recursive: true, force: true });
				}
			});
		}
	}
});
