// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { _setSynthSecretFetcher } from '@aws-blocks/hosting/constructs';
import { config } from '@aws-blocks/hosting';
import type * as cdk from 'aws-cdk-lib';
import { App, Stack } from 'aws-cdk-lib';
import { Pipeline } from './pipeline/index.js';
import type { PipelineStageConfig } from './pipeline/index.js';

const MOCK_CONNECTION_ARN = 'arn:aws:codeconnections:us-east-1:123456789012:connection/test-connection-id';

function minimalStageFactory(scope: cdk.Stage, stageConfig: PipelineStageConfig): void {
	new Stack(scope, 'AppStack', { env: stageConfig.env });
}

// B2: the core Pipeline wrapper must resolve values from the SAME namespace the
// Blocks CLI writes (`/blocks/*`), not the leaf-neutral `/hosting/*` — otherwise
// `npm run config -- set CONNECTION_ARN` writes one name and the deploy reads
// another. The leaf default is `/hosting/config`; the wrapper must pin `/blocks/config`.
void describe('core Pipeline pins the Blocks namespace', () => {
	afterEach(() => _setSynthSecretFetcher(null));

	void it('resolves a config() connectionArn under /blocks/config by default', async () => {
		const seen: string[] = [];
		_setSynthSecretFetcher(async (locator: string) => {
			seen.push(locator);
			return MOCK_CONNECTION_ARN;
		});
		await Pipeline.create(new App(), 'BlocksPipeline', {
			source: { repo: 'my-org/my-app', connectionArn: config('CONNECTION_ARN') },
			branches: [{ branch: 'main', stages: [{ name: 'prod' }] }],
			stageFactory: minimalStageFactory,
		});
		// The Blocks CLI writes /blocks/config/CONNECTION_ARN; the wrapper must read it there.
		assert.deepStrictEqual(seen, ['/blocks/config/CONNECTION_ARN']);
	});

	void it('lets the caller override the pinned prefix', async () => {
		const seen: string[] = [];
		_setSynthSecretFetcher(async (locator: string) => {
			seen.push(locator);
			return MOCK_CONNECTION_ARN;
		});
		await Pipeline.create(new App(), 'OverridePipeline', {
			source: { repo: 'my-org/my-app', connectionArn: config('CONNECTION_ARN') },
			branches: [{ branch: 'main', stages: [{ name: 'prod' }] }],
			stageFactory: minimalStageFactory,
			configStore: { prefix: '/myapp/config' },
		});
		assert.deepStrictEqual(seen, ['/myapp/config/CONNECTION_ARN']);
	});
});
