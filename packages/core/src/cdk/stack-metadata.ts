import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { OFFICIAL_BB_NAMES } from '../common/official-bb-names.generated.js';
import { CORE_VERSION } from '../version.js';

const TOOLS_METRICS_METADATA_KEY = 'AWSToolsMetrics';
const BLOCKS_TOOLS_METRICS_KEY = 'AWSBlocks';
const BLOCKS_TOOLS_METRICS_FORMAT_VERSION = 1;
const BUILDING_BLOCK_CENSUS_KEY = Symbol.for('BLOCKS_BUILDING_BLOCK_CENSUS');

interface BuildingBlockCensus {
	readonly officialNames: Set<string>;
	customCount: number;
}

/**
 * Adds AWS Blocks identification metadata and a deployment-type tag to a CloudFormation stack.
 *
 * Writes `Metadata.AWSToolsMetrics.AWSBlocks` into the template of the top-level
 * (non-nested) stack containing `stack`, with the value
 * `1;core=<core version>;mode=<sandbox|production>;bb=<names>;custom=<count>`. Other `Metadata` entries and
 * sibling keys of an object-valued `AWSToolsMetrics` are preserved; a non-object
 * `AWSToolsMetrics` value is replaced. Nested stacks never receive the entry.
 *
 * `bb` lists the official Building Blocks in the app (sorted, deduplicated, comma-separated;
 * empty if none) and `custom` counts all other Building Block instances. Both are resolved at
 * synth, so they include blocks constructed later and blocks in nested stacks.
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
	const census = getCensus(rootStack);
	const existingMetadata = rootStack.templateOptions.metadata ?? {};
	rootStack.addMetadata(TOOLS_METRICS_METADATA_KEY, {
		...asRecord(existingMetadata[TOOLS_METRICS_METADATA_KEY]),
		[BLOCKS_TOOLS_METRICS_KEY]: cdk.Lazy.string({
			produce: () =>
				`${BLOCKS_TOOLS_METRICS_FORMAT_VERSION};core=${CORE_VERSION};mode=${mode}` +
				`;bb=${[...census.officialNames].sort().join(',')};custom=${census.customCount}`,
		}),
	});

	cdk.Tags.of(stack).add('blocks:deployment-type', mode);
}

/** Records a Building Block on its top-level stack; non-official names only increment `custom`. @internal */
export function recordBuildingBlock(scope: Construct, bbName: string): void {
	const stack = scope.node.scopes.find((s): s is cdk.Stack => cdk.Stack.isStack(s));
	if (!stack) return;
	const census = getCensus(getRootStack(stack));
	if (OFFICIAL_BB_NAMES.has(bbName)) {
		census.officialNames.add(bbName);
	} else {
		census.customCount += 1;
	}
}

function getCensus(rootStack: cdk.Stack): BuildingBlockCensus {
	const holder = rootStack as unknown as Record<symbol, BuildingBlockCensus | undefined>;
	let census = holder[BUILDING_BLOCK_CENSUS_KEY];
	if (!census) {
		census = { officialNames: new Set(), customCount: 0 };
		holder[BUILDING_BLOCK_CENSUS_KEY] = census;
	}
	return census;
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
