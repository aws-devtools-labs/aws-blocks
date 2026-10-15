import assert from 'node:assert';
import { describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CORE_VERSION } from '../version.js';
import { addBlocksStackMetadata } from './stack-metadata.js';

describe('addBlocksStackMetadata', () => {
	test('writes Metadata.AWSToolsMetrics.AWSBlocks with format version, core version and production mode', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'TestStack');

		addBlocksStackMetadata(stack);

		const metadata = Template.fromStack(stack).toJSON().Metadata;
		assert.deepStrictEqual(metadata.AWSToolsMetrics, {
			AWSBlocks: `1;core=${CORE_VERSION};mode=production`,
		});
	});

	test('does not write the legacy AWS::Blocks::Platform metadata key', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'NoLegacyStack');

		addBlocksStackMetadata(stack);

		const metadata = Template.fromStack(stack).toJSON().Metadata;
		assert.strictEqual(metadata['AWS::Blocks::Platform'], undefined);
	});

	test('writes mode=sandbox when sandboxMode context is boolean true', () => {
		const app = new cdk.App({ context: { sandboxMode: true } });
		const stack = new cdk.Stack(app, 'SandboxMetaBoolStack');

		addBlocksStackMetadata(stack);

		const metadata = Template.fromStack(stack).toJSON().Metadata;
		assert.strictEqual(metadata.AWSToolsMetrics.AWSBlocks, `1;core=${CORE_VERSION};mode=sandbox`);
	});

	test('writes mode=sandbox when sandboxMode context is string "true"', () => {
		const app = new cdk.App({ context: { sandboxMode: 'true' } });
		const stack = new cdk.Stack(app, 'SandboxMetaStringStack');

		addBlocksStackMetadata(stack);

		const metadata = Template.fromStack(stack).toJSON().Metadata;
		assert.strictEqual(metadata.AWSToolsMetrics.AWSBlocks, `1;core=${CORE_VERSION};mode=sandbox`);
	});

	test('writes mode=production when sandboxMode context is string "false"', () => {
		const app = new cdk.App({ context: { sandboxMode: 'false' } });
		const stack = new cdk.Stack(app, 'SandboxFalseStack');

		addBlocksStackMetadata(stack);

		const metadata = Template.fromStack(stack).toJSON().Metadata;
		assert.strictEqual(metadata.AWSToolsMetrics.AWSBlocks, `1;core=${CORE_VERSION};mode=production`);
	});

	test('preserves existing template metadata and other AWSToolsMetrics entries', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'ExistingMetaStack');
		stack.templateOptions.metadata = {
			'Custom::Existing': { key: 'value' },
			AWSToolsMetrics: { OtherTool: 'x' },
		};

		addBlocksStackMetadata(stack);

		const metadata = Template.fromStack(stack).toJSON().Metadata;
		assert.deepStrictEqual(metadata['Custom::Existing'], { key: 'value' });
		assert.deepStrictEqual(metadata.AWSToolsMetrics, {
			OtherTool: 'x',
			AWSBlocks: `1;core=${CORE_VERSION};mode=production`,
		});
	});

	for (const [label, malformed] of [
		['string', 'not-an-object'],
		['array', ['a', 'b']],
		['null', null],
	] as const) {
		test(`replaces a non-object AWSToolsMetrics value (${label}) instead of spreading it`, () => {
			const app = new cdk.App();
			const stack = new cdk.Stack(app, `Malformed${label}Stack`);
			stack.templateOptions.metadata = { AWSToolsMetrics: malformed };

			addBlocksStackMetadata(stack);

			const metadata = Template.fromStack(stack).toJSON().Metadata;
			assert.deepStrictEqual(metadata.AWSToolsMetrics, {
				AWSBlocks: `1;core=${CORE_VERSION};mode=production`,
			});
		});
	}

	test('is idempotent when called more than once on the same stack', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'TwiceStack');

		addBlocksStackMetadata(stack);
		addBlocksStackMetadata(stack);

		const metadata = Template.fromStack(stack).toJSON().Metadata;
		assert.deepStrictEqual(metadata.AWSToolsMetrics, {
			AWSBlocks: `1;core=${CORE_VERSION};mode=production`,
		});
	});

	test('writes the metadata to the root stack, not the nested stack', () => {
		const app = new cdk.App();
		const root = new cdk.Stack(app, 'RootStack');
		const nested = new cdk.NestedStack(root, 'Nested');
		new cdk.CfnWaitConditionHandle(nested, 'Placeholder');

		addBlocksStackMetadata(nested);

		const rootMetadata = Template.fromStack(root).toJSON().Metadata;
		assert.strictEqual(rootMetadata.AWSToolsMetrics.AWSBlocks, `1;core=${CORE_VERSION};mode=production`);
		const nestedMetadata = Template.fromStack(nested).toJSON().Metadata;
		assert.strictEqual(nestedMetadata?.AWSToolsMetrics, undefined);
	});

	test('tags deployment-type as production when sandboxMode context is absent', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'ProdStack');

		addBlocksStackMetadata(stack);

		const assembly = app.synth();
		const stackArtifact = assembly.getStackByName(stack.stackName);
		assert.strictEqual(stackArtifact.tags['blocks:deployment-type'], 'production');
	});

	test('tags deployment-type as sandbox when sandboxMode context is boolean true', () => {
		const app = new cdk.App({ context: { sandboxMode: true } });
		const stack = new cdk.Stack(app, 'SandboxBoolStack');

		addBlocksStackMetadata(stack);

		const assembly = app.synth();
		const stackArtifact = assembly.getStackByName(stack.stackName);
		assert.strictEqual(stackArtifact.tags['blocks:deployment-type'], 'sandbox');
	});

	test('tags deployment-type as sandbox when sandboxMode context is string "true"', () => {
		const app = new cdk.App({ context: { sandboxMode: 'true' } });
		const stack = new cdk.Stack(app, 'SandboxStringStack');

		addBlocksStackMetadata(stack);

		const assembly = app.synth();
		const stackArtifact = assembly.getStackByName(stack.stackName);
		assert.strictEqual(stackArtifact.tags['blocks:deployment-type'], 'sandbox');
	});
});
