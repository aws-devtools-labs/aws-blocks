import * as cdk from 'aws-cdk-lib';
import type { Construct, IConstruct } from 'constructs';
import { OFFICIAL_BB_NAMES } from '../common/official-bb-names.generated.js';
import { isDisableValue } from '../telemetry/consent.js';
import { CORE_VERSION } from '../version.js';

const TOOLS_METRICS_METADATA_KEY = 'AWSToolsMetrics';
const BLOCKS_TOOLS_METRICS_KEY = 'AWSBlocks';
const BLOCKS_TOOLS_METRICS_FORMAT_VERSION = 1;
const BUILDING_BLOCK_CENSUS_KEY = Symbol.for('BLOCKS_BUILDING_BLOCK_CENSUS');
const TEMPLATE_METADATA_DISABLE_ENV = 'AWS_BLOCKS_DISABLE_TEMPLATE_METADATA';
const TEMPLATE_METADATA_CONTEXT_KEY = 'blocks:template-metadata';
const CDK_VERSION_REPORTING_CONTEXT_KEY = 'aws:cdk:version-reporting';
// Set by the CDK CLI instead of `aws:cdk:version-reporting` when version reporting is off.
const CDK_DISABLE_VERSION_REPORTING_CONTEXT_KEY = 'aws:cdk:disable-version-reporting';

interface BuildingBlockCensus {
	readonly officialNames: Set<string>;
	customCount: number;
}

/**
 * Whether `scope` is being synthesized for a sandbox (dev-loop) deployment.
 *
 * Reads the CDK context key `sandboxMode`, which the sandbox scripts pass as
 * `-c sandboxMode=true`; both the string `'true'` and boolean `true` count.
 * Anything else (absent, `'false'`, ...) means a production deployment.
 *
 * This is the single source of truth for the synth-time deployment type: it
 * drives the `blocks:deployment-type` tag and the `BLOCKS_DEPLOYMENT_TYPE`
 * value propagated to deployed compute (read back at runtime via
 * `getDeploymentType()`).
 *
 * @param scope - Any construct in the app; context is inherited from the app.
 */
export function isSandboxContext(scope: IConstruct): boolean {
	const value = scope.node.tryGetContext('sandboxMode');
	return value === 'true' || value === true;
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
 * The `AWSBlocks` entry is enabled by default. It is omitted entirely, leaving any existing
 * `AWSToolsMetrics` value untouched, in any of these cases:
 * - the env var `AWS_BLOCKS_DISABLE_TEMPLATE_METADATA` is `1`, `true` or `yes`
 *   (case-insensitive, trimmed);
 * - the CDK context key `blocks:template-metadata` is `false` or `"false"`;
 * - CDK version reporting is turned off (`cdk --no-version-reporting`, `"versionReporting": false`
 *   in `cdk.json`, `new App({ analyticsReporting: false })`, or the context key
 *   `aws:cdk:version-reporting` set to `false`).
 *   Via the CDK CLI, use `--no-version-reporting` or `cdk.json`; `-c aws:cdk:version-reporting=false` is overridden.
 * The CLI telemetry opt-out (`AWS_BLOCKS_DISABLE_TELEMETRY`, `.blocks/config.json`) does not
 * affect it. The `blocks:deployment-type` tag is applied either way.
 *
 * @param stack - The CDK stack to annotate. May be a nested stack; the metadata is
 *   then written to its root stack.
 */
export function addBlocksStackMetadata(stack: cdk.Stack): void {
	const mode = isSandboxContext(stack) ? 'sandbox' : 'production';
	cdk.Tags.of(stack).add('blocks:deployment-type', mode);

	const rootStack = getRootStack(stack);
	if (!isTemplateMetadataEnabled(rootStack)) return;

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
}

function isTemplateMetadataEnabled(scope: Construct): boolean {
	if (isDisableValue(process.env[TEMPLATE_METADATA_DISABLE_ENV])) return false;
	const context = (key: string): unknown => scope.node.tryGetContext(key);
	if (isFalse(context(TEMPLATE_METADATA_CONTEXT_KEY))) return false;
	if (isFalse(context(CDK_VERSION_REPORTING_CONTEXT_KEY))) return false;
	const cdkDisabled = context(CDK_DISABLE_VERSION_REPORTING_CONTEXT_KEY);
	return !(cdkDisabled === true || cdkDisabled === 'true');
}

function isFalse(value: unknown): boolean {
	return value === false || value === 'false';
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
