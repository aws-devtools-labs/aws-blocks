// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	BACKEND_OUTPUT_KEY,
	OUTPUTS_FILE,
	outputsFilePath,
	readStageOutputs,
	regionFromOutputs,
	resolveStageRegion,
} from './stage-outputs.js';

/** A project root with the given stage files written into `.blocks-sandbox/`. */
function project(files: Record<string, unknown>): string {
	const root = mkdtempSync(join(tmpdir(), 'blocks-stage-outputs-'));
	mkdirSync(join(root, '.blocks-sandbox'), { recursive: true });
	for (const [relative, content] of Object.entries(files)) {
		const target = join(root, ...relative.split('/'));
		writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
	}
	return root;
}

const EU_BACKEND = {
	ApiUrl: 'https://a1b2c3d4e5.execute-api.eu-west-1.amazonaws.com/prod/aws-blocks/api',
	HostingCdnDistributionUrl6712AC73: 'https://d1a2b3c4d5e6f7.cloudfront.net',
};

/**
 * Core's counterpart to this module. Relative to this file, which sits at the
 * same depth in `src/` and in the compiled `dist/`, so one path serves both.
 */
const CORE_DEPLOY_OUTPUTS = '../../../core/dist/scripts/deploy-outputs.js';

/** The part of core's module this guard compares against. */
interface CoreDeployOutputs {
	OUTPUTS_FILE: Record<string, string>;
	BACKEND_OUTPUT_KEY: string;
}

describe('OUTPUTS_FILE agrees with core', () => {
	/**
	 * The drift guard for this module's deliberate duplication of core's
	 * `deploy-outputs.ts`. When core's build carries that module the two values
	 * are compared for real; when it does not (admin-ui ships standalone into a
	 * user's project, core is unbuilt, or core does not own these paths yet) there
	 * is nothing to compare against and the check skips.
	 *
	 * The skip is decided by whether the file is on disk, not by catching an
	 * import failure, so a wrong path or a broken module fails here instead of
	 * quietly turning the guard into a no-op. The specifier is held in a variable
	 * because the module is resolved at run time only: a static specifier would
	 * make this file fail to compile wherever core has no such module.
	 */
	it('pins the same per-stage paths and backend output key', async () => {
		if (!existsSync(fileURLToPath(new URL(CORE_DEPLOY_OUTPUTS, import.meta.url)))) return;

		const core = (await import(CORE_DEPLOY_OUTPUTS)) as CoreDeployOutputs;
		assert.deepStrictEqual({ ...OUTPUTS_FILE }, { ...core.OUTPUTS_FILE });
		assert.strictEqual(BACKEND_OUTPUT_KEY, core.BACKEND_OUTPUT_KEY);
	});

	it('keeps the two stages in separate files', () => {
		// The defect this whole module exists for: one shared path let each stage
		// erase the other's record, so the dashboard read production's values for
		// the sandbox.
		assert.notStrictEqual(OUTPUTS_FILE.sandbox, OUTPUTS_FILE.production);
	});

	it('resolves an absolute path under the project root', () => {
		assert.strictEqual(
			outputsFilePath('production', '/app'),
			join('/app', '.blocks-sandbox', 'outputs.production.json'),
		);
	});
});

describe('readStageOutputs', () => {
	it('selects the stack publishing ApiUrl', () => {
		const root = project({ '.blocks-sandbox/outputs.json': { 'app-sandbox': EU_BACKEND } });
		const result = readStageOutputs(root, 'sandbox');
		assert.strictEqual(result.status, 'found');
		assert.strictEqual(result.stackName, 'app-sandbox');
	});

	it('reads each stage from its own file, never the other stage s', () => {
		const root = project({
			'.blocks-sandbox/outputs.json': { 'app-sandbox': EU_BACKEND },
			'.blocks-sandbox/outputs.production.json': {
				'app-prod': { ApiUrl: 'https://p.execute-api.us-east-1.amazonaws.com/prod/' },
			},
		});
		assert.strictEqual(readStageOutputs(root, 'sandbox').stackName, 'app-sandbox');
		assert.strictEqual(readStageOutputs(root, 'production').stackName, 'app-prod');
	});

	it('ignores a second stack with no ApiUrl (the Lambda@Edge stack)', () => {
		const root = project({
			'.blocks-sandbox/outputs.json': {
				'edge-lambda-stack-abc': { Fn: 'arn:aws:lambda:us-east-1:1:function:edge' },
				'app-sandbox': EU_BACKEND,
			},
		});
		const result = readStageOutputs(root, 'sandbox');
		assert.strictEqual(result.status, 'found');
		// Position would have picked the edge stack: it serializes first.
		assert.strictEqual(result.stackName, 'app-sandbox');
	});

	it('reports a missing file as no-record, naming the writer command', () => {
		const result = readStageOutputs(project({}), 'production');
		assert.strictEqual(result.status, 'no-record');
		assert.match(result.reason ?? '', /npm run deploy/);
	});

	it('reports an empty document as unusable, not as no-record', () => {
		// A failed deploy writes {} from the CDK CLI's finally block. That is NOT
		// "you never deployed" — a standing stack may still exist.
		const result = readStageOutputs(project({ '.blocks-sandbox/outputs.json': {} }), 'sandbox');
		assert.strictEqual(result.status, 'unusable');
		assert.match(result.reason ?? '', /failed/);
	});

	it('refuses to guess between two ApiUrl stacks', () => {
		const root = project({
			'.blocks-sandbox/outputs.json': { a: EU_BACKEND, b: EU_BACKEND },
		});
		const result = readStageOutputs(root, 'sandbox');
		assert.strictEqual(result.status, 'unusable');
		assert.match(result.reason ?? '', /refusing to guess/);
	});

	it('reports malformed JSON as unusable', () => {
		const root = project({ '.blocks-sandbox/outputs.json': '{ not json' });
		assert.strictEqual(readStageOutputs(root, 'sandbox').status, 'unusable');
	});

	it('reports a non-object document as unusable', () => {
		const root = project({ '.blocks-sandbox/outputs.json': '[]' });
		const result = readStageOutputs(root, 'sandbox');
		assert.strictEqual(result.status, 'unusable');
		assert.match(result.reason ?? '', /an array/);
	});
});

describe('regionFromOutputs', () => {
	it('reads the region from ApiUrl', () => {
		assert.strictEqual(regionFromOutputs(EU_BACKEND).region, 'eu-west-1');
	});

	it('is not overruled by an off-region ARN in another output', () => {
		// A hosting app publishes a us-east-1 SNS topic for the CloudFront alarm
		// that must live there (D-016). "Every output must agree" would throw away
		// a region we can read exactly, in the apps that have the most to show.
		const region = regionFromOutputs({
			...EU_BACKEND,
			HostingMonitoringTopicArn: 'arn:aws:sns:us-east-1:123456789012:alarm-topic',
		}).region;
		assert.strictEqual(region, 'eu-west-1');
	});

	it('falls back to another output when ApiUrl carries no region', () => {
		const region = regionFromOutputs({
			ApiUrl: 'https://api.example.com/',
			Topic: 'arn:aws:sns:ap-southeast-1:1:t',
		}).region;
		assert.strictEqual(region, 'ap-southeast-1');
	});

	it('yields nothing when the fallback outputs disagree', () => {
		const result = regionFromOutputs({
			ApiUrl: 'https://api.example.com/',
			A: 'arn:aws:sns:eu-west-1:1:t',
			B: 'arn:aws:sns:us-east-1:1:t',
		});
		assert.strictEqual(result.region, undefined);
		assert.match(result.reason ?? '', /disagree/);
	});

	it('yields nothing when no output names a region', () => {
		const result = regionFromOutputs({
			ApiUrl: 'https://api.example.com/',
			Cdn: 'https://d1a2b3c4d5e6f7.cloudfront.net',
			Bucket: 'my-build-cache-bucket',
		});
		assert.strictEqual(result.region, undefined);
		assert.match(result.reason ?? '', /region-free/);
	});

	it('does not mistake a CloudFront domain for a regional hostname', () => {
		assert.strictEqual(regionFromOutputs({ ApiUrl: 'https://d123.cloudfront.net' }).region, undefined);
	});
});

describe('resolveStageRegion precedence', () => {
	const root = project({ '.blocks-sandbox/outputs.json': { 'app-sandbox': EU_BACKEND } });

	it('tier 1: --region wins over everything, including the outputs file', () => {
		const result = resolveStageRegion(root, 'sandbox', { cli: 'ap-southeast-1', env: 'us-east-1' });
		assert.strictEqual(result.region, 'ap-southeast-1');
		assert.strictEqual(result.source, 'cli');
	});

	it('tier 2: AWS_REGION wins over the outputs file', () => {
		const result = resolveStageRegion(root, 'sandbox', { env: 'us-east-1' });
		assert.strictEqual(result.region, 'us-east-1');
		assert.strictEqual(result.source, 'env');
	});

	it('tier 3: the stage s own outputs file', () => {
		const result = resolveStageRegion(root, 'sandbox', {});
		assert.strictEqual(result.region, 'eu-west-1');
		assert.strictEqual(result.source, 'outputs');
	});

	it('tier 4: nothing stated and no outputs file means no deployment here', () => {
		const result = resolveStageRegion(project({}), 'sandbox', {});
		assert.strictEqual(result.region, undefined);
		assert.strictEqual(result.source, 'none');
		assert.strictEqual(result.outputs.status, 'no-record');
	});

	it('still reports the region when the outputs file is unusable but a flag is set', () => {
		// The flag is enough to perform a lookup; the unusable file only costs us
		// the stack name from the document.
		const broken = project({ '.blocks-sandbox/outputs.json': {} });
		const result = resolveStageRegion(broken, 'sandbox', { cli: 'eu-west-1' });
		assert.strictEqual(result.region, 'eu-west-1');
		assert.strictEqual(result.source, 'cli');
		assert.strictEqual(result.outputs.status, 'unusable');
	});

	it('carries the outputs status through so a caller can tell no-record from unusable', () => {
		const broken = project({ '.blocks-sandbox/outputs.json': {} });
		assert.strictEqual(resolveStageRegion(broken, 'sandbox', {}).outputs.status, 'unusable');
		assert.strictEqual(resolveStageRegion(project({}), 'sandbox', {}).outputs.status, 'no-record');
	});

	it('resolves the two stages independently', () => {
		const both = project({
			'.blocks-sandbox/outputs.json': { 'app-sandbox': EU_BACKEND },
			'.blocks-sandbox/outputs.production.json': {
				'app-prod': { ApiUrl: 'https://p.execute-api.us-east-1.amazonaws.com/prod/' },
			},
		});
		assert.strictEqual(resolveStageRegion(both, 'sandbox', {}).region, 'eu-west-1');
		assert.strictEqual(resolveStageRegion(both, 'production', {}).region, 'us-east-1');
	});
});
