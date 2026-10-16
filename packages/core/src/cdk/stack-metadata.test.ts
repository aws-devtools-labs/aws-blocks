import assert from 'node:assert';
import { describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Construct } from 'constructs';
import type { ScopeParent } from '../common/index.js';
import { CORE_VERSION } from '../version.js';
import { Scope } from './index.js';
import { addBlocksStackMetadata, recordBuildingBlock } from './stack-metadata.js';

function blocksValue(stack: cdk.Stack): string {
	return Template.fromStack(stack).toJSON().Metadata.AWSToolsMetrics.AWSBlocks;
}

describe('addBlocksStackMetadata', () => {
	test('writes Metadata.AWSToolsMetrics.AWSBlocks with format version, core version and production mode', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'TestStack');

		addBlocksStackMetadata(stack);

		const metadata = Template.fromStack(stack).toJSON().Metadata;
		assert.deepStrictEqual(metadata.AWSToolsMetrics, {
			AWSBlocks: `1;core=${CORE_VERSION};mode=production;bb=;custom=0`,
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
		assert.strictEqual(metadata.AWSToolsMetrics.AWSBlocks, `1;core=${CORE_VERSION};mode=sandbox;bb=;custom=0`);
	});

	test('writes mode=sandbox when sandboxMode context is string "true"', () => {
		const app = new cdk.App({ context: { sandboxMode: 'true' } });
		const stack = new cdk.Stack(app, 'SandboxMetaStringStack');

		addBlocksStackMetadata(stack);

		const metadata = Template.fromStack(stack).toJSON().Metadata;
		assert.strictEqual(metadata.AWSToolsMetrics.AWSBlocks, `1;core=${CORE_VERSION};mode=sandbox;bb=;custom=0`);
	});

	test('writes mode=production when sandboxMode context is string "false"', () => {
		const app = new cdk.App({ context: { sandboxMode: 'false' } });
		const stack = new cdk.Stack(app, 'SandboxFalseStack');

		addBlocksStackMetadata(stack);

		const metadata = Template.fromStack(stack).toJSON().Metadata;
		assert.strictEqual(metadata.AWSToolsMetrics.AWSBlocks, `1;core=${CORE_VERSION};mode=production;bb=;custom=0`);
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
			AWSBlocks: `1;core=${CORE_VERSION};mode=production;bb=;custom=0`,
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
				AWSBlocks: `1;core=${CORE_VERSION};mode=production;bb=;custom=0`,
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
			AWSBlocks: `1;core=${CORE_VERSION};mode=production;bb=;custom=0`,
		});
	});

	test('writes the metadata to the root stack, not the nested stack', () => {
		const app = new cdk.App();
		const root = new cdk.Stack(app, 'RootStack');
		const nested = new cdk.NestedStack(root, 'Nested');
		new cdk.CfnWaitConditionHandle(nested, 'Placeholder');

		addBlocksStackMetadata(nested);

		const rootMetadata = Template.fromStack(root).toJSON().Metadata;
		assert.strictEqual(
			rootMetadata.AWSToolsMetrics.AWSBlocks,
			`1;core=${CORE_VERSION};mode=production;bb=;custom=0`,
		);
		const nestedMetadata = Template.fromStack(nested).toJSON().Metadata;
		assert.strictEqual(nestedMetadata?.AWSToolsMetrics, undefined);
	});

	test('lists official building blocks sorted and deduplicated, recorded before or after the call', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'BlocksStack');
		recordBuildingBlock(new Construct(stack, 'a'), 'KVStore');

		addBlocksStackMetadata(stack);

		recordBuildingBlock(new Construct(stack, 'b'), 'AuthCognito');
		recordBuildingBlock(new Construct(stack, 'c'), 'KVStore');
		recordBuildingBlock(new Construct(stack, 'd'), 'FileBucket');

		assert.strictEqual(
			blocksValue(stack),
			`1;core=${CORE_VERSION};mode=production;bb=AuthCognito,FileBucket,KVStore;custom=0`,
		);
	});

	test('counts every non-official building block instance as custom without recording its name', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'CustomStack');
		addBlocksStackMetadata(stack);

		recordBuildingBlock(new Construct(stack, 'a'), 'MyWidget');
		recordBuildingBlock(new Construct(stack, 'b'), 'MyWidget');
		recordBuildingBlock(new Construct(stack, 'c'), 'OtherThing');
		recordBuildingBlock(new Construct(stack, 'd'), 'Secret');

		const value = blocksValue(stack);
		assert.strictEqual(value, `1;core=${CORE_VERSION};mode=production;bb=Secret;custom=3`);
		assert.ok(!value.includes('MyWidget'));
	});

	test('counts building blocks in nested stacks toward the root stack only', () => {
		const app = new cdk.App();
		const root = new cdk.Stack(app, 'RootBlocksStack');
		const nested = new cdk.NestedStack(root, 'Nested');
		const deeper = new cdk.NestedStack(nested, 'Deeper');
		new cdk.CfnWaitConditionHandle(deeper, 'Placeholder');
		addBlocksStackMetadata(nested);

		recordBuildingBlock(new Construct(root, 'a'), 'Logger');
		recordBuildingBlock(new Construct(nested, 'b'), 'KVStore');
		recordBuildingBlock(new Construct(deeper, 'c'), 'AsyncJob');
		recordBuildingBlock(new Construct(deeper, 'd'), 'MyWidget');

		assert.strictEqual(
			blocksValue(root),
			`1;core=${CORE_VERSION};mode=production;bb=AsyncJob,KVStore,Logger;custom=1`,
		);
		assert.strictEqual(Template.fromStack(nested).toJSON().Metadata?.AWSToolsMetrics, undefined);
		assert.strictEqual(Template.fromStack(deeper).toJSON().Metadata?.AWSToolsMetrics, undefined);
	});

	test('keeps building blocks of separate root stacks apart', () => {
		const app = new cdk.App();
		const first = new cdk.Stack(app, 'FirstStack');
		const second = new cdk.Stack(app, 'SecondStack');
		addBlocksStackMetadata(first);
		addBlocksStackMetadata(second);

		recordBuildingBlock(new Construct(first, 'a'), 'KVStore');
		recordBuildingBlock(new Construct(second, 'b'), 'Tracer');

		assert.strictEqual(blocksValue(first), `1;core=${CORE_VERSION};mode=production;bb=KVStore;custom=0`);
		assert.strictEqual(blocksValue(second), `1;core=${CORE_VERSION};mode=production;bb=Tracer;custom=0`);
	});

	test('preserves sibling AWSToolsMetrics keys alongside the building block fields', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'SiblingStack');
		stack.templateOptions.metadata = { AWSToolsMetrics: { OtherTool: 'x' } };
		addBlocksStackMetadata(stack);
		recordBuildingBlock(new Construct(stack, 'a'), 'Metrics');

		assert.deepStrictEqual(Template.fromStack(stack).toJSON().Metadata.AWSToolsMetrics, {
			OtherTool: 'x',
			AWSBlocks: `1;core=${CORE_VERSION};mode=production;bb=Metrics;custom=0`,
		});
	});

	test('ignores a building block that is not inside a stack', () => {
		assert.doesNotThrow(() => recordBuildingBlock(new Construct(new cdk.App(), 'Loose'), 'KVStore'));
	});

	test('Scope records its bbName on the root stack; scopes without one are not counted', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'ScopeStack');
		addBlocksStackMetadata(stack);
		const parent = stack as unknown as ScopeParent;

		const app1 = new Scope('app', { parent });
		const kv = new Scope('notes', { parent: app1, bbName: 'KVStore', bbVersion: '1.2.3' });
		new Scope('custom', { parent: app1, bbName: 'MyWidget' });

		assert.strictEqual(kv.bbName, 'KVStore');
		assert.strictEqual(kv.bbVersion, '1.2.3');
		assert.strictEqual(app1.bbName, undefined);
		assert.strictEqual(blocksValue(stack), `1;core=${CORE_VERSION};mode=production;bb=KVStore;custom=1`);
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
