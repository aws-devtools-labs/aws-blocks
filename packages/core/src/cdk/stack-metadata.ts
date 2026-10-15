import * as cdk from 'aws-cdk-lib';
import { CORE_VERSION } from '../version.js';

// CloudFormation's tooling-metrics pipeline only reads Metadata.AWSToolsMetrics.<tool key> (ticket V2410116015).
const TOOLS_METRICS_METADATA_KEY = 'AWSToolsMetrics';
const BLOCKS_TOOLS_METRICS_KEY = 'AWSBlocks';
const BLOCKS_TOOLS_METRICS_FORMAT_VERSION = 1;

/**
 * Adds AWS Blocks identification metadata and a deployment-type tag to a CloudFormation stack.
 *
 * Writes `Metadata.AWSToolsMetrics.AWSBlocks` into the template of the top-level
 * (non-nested) stack containing `stack`, with the value
 * `1;core=<core version>;mode=<sandbox|production>`. Other `Metadata` entries and
 * sibling keys of an object-valued `AWSToolsMetrics` are preserved; a non-object
 * `AWSToolsMetrics` value is replaced. Nested stacks never receive the entry, so
 * each Blocks deployment is counted once.
 *
 * Also applies a `blocks:deployment-type` tag (`sandbox` or `production`) to `stack`.
 * The mode is derived from the CDK context key `sandboxMode`.
 *
 * @param stack - The CDK stack to annotate. May be a nested stack; the metadata is
 *   then written to its root stack.
 */
export function addBlocksStackMetadata(stack: cdk.Stack): void {
	const isSandbox =
		stack.node.tryGetContext('sandboxMode') === 'true' || stack.node.tryGetContext('sandboxMode') === true;
	const mode = isSandbox ? 'sandbox' : 'production';

	const rootStack = getRootStack(stack);
	const existingMetadata = rootStack.templateOptions.metadata ?? {};
	rootStack.templateOptions.metadata = {
		...existingMetadata,
		[TOOLS_METRICS_METADATA_KEY]: {
			...asRecord(existingMetadata[TOOLS_METRICS_METADATA_KEY]),
			[BLOCKS_TOOLS_METRICS_KEY]: `${BLOCKS_TOOLS_METRICS_FORMAT_VERSION};core=${CORE_VERSION};mode=${mode}`,
		},
	};

	cdk.Tags.of(stack).add('blocks:deployment-type', mode);
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function getRootStack(stack: cdk.Stack): cdk.Stack {
	let current = stack;
	while (current.nestedStackParent) {
		current = current.nestedStackParent;
	}
	return current;
}
