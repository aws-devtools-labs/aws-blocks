// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import type * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CfnGroup } from 'aws-cdk-lib/aws-resourcegroups';
import { Construct } from 'constructs';
import { registerBuiltinRoutes } from '../builtin-routes.js';
import { addOrphanedBaselineCheck } from './baselines.js';
import type { BlocksDefaults } from './blocks-defaults.js';
import type { ComputeBase } from './compute/compute.js';
import { getComputes } from './compute/compute-registry.js';
import type { DefaultComputeFactory, LambdaShapedCompute } from './compute/default-compute-factory.js';
import type { ApiFrontDoorTier } from '../common/index.js';
import {
	type ApiFrontDoorOwner,
	claimApiFrontDoor,
	publishPublicOrigin,
	publicApiUrl,
	resolveApiFrontDoor,
	scheduleApiFrontDoor,
} from './api-front-door.js';
import { finalizeConfigRegistry, registerConfig } from './config-registry.js';
import { finalizeDashboards } from './dashboard-registry.js';
import { attachIamReport } from './iam-report.js';
import { coverBlocksRoot, coverStackLevelAdditions, snapshotChildren } from './blocks-roles.js';
import { applyBlocksPermissionsBoundary, warnOnMixedBoundaries } from './permissions-boundary.js';
import { BLOCKS_BACKEND_ROOT } from './root-registry.js';
import { createSharedGateway, resolveNamespaceRoutes, type SharedGateway } from './shared-gateway.js';
import { addBlocksStackMetadata, isSandboxContext } from './stack-metadata.js';
import { finalizeTracing } from './tracer-registry.js';
import { anyRequirementNeedsVpc, finalizeVpc, getOrCreateVpc, initializeVpc, isVpcInitialized } from './vpc.js';
import type { BlocksVpcOptions } from './vpc-types.js';

/**
 * Validate that the Node.js process was started with `--conditions=cdk`.
 *
 * Without this condition, conditional exports in Building Block packages
 * resolve to their mock/default entry points instead of the CDK entry points.
 * This causes a silent deployment failure: CDK synth "succeeds" but produces
 * no real infrastructure (no tables, no IAM, no Lambda configs).
 */
export function assertCdkConditionActive(): void {
	const nodeOptions = process.env.NODE_OPTIONS ?? '';
	const execArgv = process.execArgv ?? [];

	const hasCdkCondition =
		execArgv.some((arg) => arg === '--conditions=cdk') ||
		execArgv.some((arg, i) => (arg === '--conditions' || arg === '-C') && execArgv[i + 1] === 'cdk') ||
		nodeOptions.includes('--conditions=cdk') ||
		/(?:--conditions|-C)\s+cdk/.test(nodeOptions);

	if (!hasCdkCondition) {
		throw new Error(
			'Missing --conditions=cdk: Building Blocks will silently load mock implementations instead of CDK constructs.\n\n' +
				'Fix: Set NODE_OPTIONS="--conditions=cdk" before running CDK synth:\n' +
				'  NODE_OPTIONS="--conditions=cdk" npx cdk synth\n\n' +
				'Or use the Blocks CLI commands (npm run deploy / npm run sandbox) which set this automatically.',
		);
	}
}

/**
 * Timeout of the shared Blocks handler Lambda, and therefore the ceiling on a
 * single invocation. Exported because resources that feed the handler have to
 * size their own timeouts against it (e.g. an SQS queue's visibility timeout).
 */
export const SHARED_HANDLER_TIMEOUT_SECONDS = 60 * 15;

export interface BlocksBackendProps {
	backendHandlerPath: string;
	backendCDKPath: string;
	/**
	 * Stack-wide infrastructure defaults applied to every Building Block (removal
	 * policy, deletion protection, …). See {@link BlocksDefaults}. Start from
	 * `BlocksPresets.sandbox` or `BlocksPresets.production` and override
	 * individual fields as needed. A per-block option always wins over the
	 * corresponding stack default.
	 */
	defaults: BlocksDefaults;
	/**
	 * How the backend's API is exposed to clients: `'apigateway'` (default) or
	 * `'cloudfront'`. Read {@link BlocksBackend.publicApiUrl} for the URL clients
	 * should call. ⚠️ Switching tiers — or adding or removing `Hosting` under
	 * `'cloudfront'` — changes the API's endpoint domain and signs users out.
	 *
	 * @see BlocksStackProps.apiFrontDoor for the full description of each tier.
	 */
	apiFrontDoor?: ApiFrontDoorTier;
}

/**
 * Core's `create()` props: the public {@link BlocksBackendProps} plus the
 * required `defaultComputeFactory`, spread on by the umbrella (`@aws-blocks/blocks`).
 * Customers use {@link BlocksBackendProps} and never set the factory.
 *
 * @internal
 */
export interface CoreBlocksBackendProps extends BlocksBackendProps {
	/** Builds the backend's default compute. Injected by `@aws-blocks/blocks`. */
	defaultComputeFactory: DefaultComputeFactory;
}

/**
 * Emit a synth-time warning when the stack is deployed with a durable removal
 * policy but API Gateway access logging is off — so the tradeoff is visible at
 * `cdk synth` rather than discovered as a missing audit trail later.
 *
 * `accessLogging` is deliberately off by default in BOTH presets (see the
 * {@link BlocksDefaults.accessLogging} field doc): enabling it provisions the
 * account/region-level API Gateway CloudWatch Logs role, an AWS-side singleton a
 * second Blocks stack can repoint on deploy or break on teardown. We must NOT
 * flip that default, but a durable deployment silently having no request-level
 * audit trail is worth surfacing.
 *
 * The gap is detected from the resolved defaults rather than by identity to a
 * preset object (which any per-field override would break): the trigger is a
 * durable removal policy (any removal policy other than DESTROY) with access
 * logging off. Keying on durability alone also covers postures the old RETAIN +
 * deletion-protection check missed — a durable stack that turns deletion
 * protection off (`{ ...BlocksPresets.production, deletionProtection: false }`),
 * and the SNAPSHOT and RETAIN_ON_UPDATE_OR_DELETE removal policies. The sandbox
 * posture (DESTROY) and any explicit `accessLogging: true` override are correctly
 * excluded; any other falsy `accessLogging` still warns, so a plain-JS caller
 * who omits the field gets both the default-off behavior AND this warning (the
 * truthiness check matches how consumer blocks read `defaults.accessLogging`).
 * Warning only — never throws — and fires at most once per
 * BlocksStack/BlocksBackend (so multiple backends in one stack each warn for
 * their own posture).
 *
 * To silence it deliberately, acknowledge the warning on the stack or backend
 * returned by `create()` after it resolves — see the message for the exact call.
 */
function warnIfDurableWithoutAccessLogging(scope: Construct, defaults: BlocksDefaults): void {
	const isDurableAuditGap = defaults.removalPolicy !== cdk.RemovalPolicy.DESTROY && !defaults.accessLogging;
	if (!isDurableAuditGap) return;

	cdk.Annotations.of(scope).addWarningV2(
		'blocks:apigateway:access-logging-disabled',
		'This deployment has a durable removal policy (its stateful resources are not destroyed on ' +
			'teardown) but API Gateway access logging is disabled, so it has no request-level audit ' +
			'trail. It is off by default because enabling it provisions the account/region-level API ' +
			'Gateway CloudWatch Logs role — an AWS-side singleton that a second Blocks stack in the same ' +
			'account+region can repoint on deploy or leave broken on teardown (see the `accessLogging` ' +
			'field docs on the backend `defaults`). Once you have confirmed a single Blocks stack owns ' +
			"that role in the region, opt in by setting `accessLogging: true` in this backend's " +
			'`defaults`; opting in also enables S3 server access logging for any FileBucket, each of ' +
			'which then gets its own log bucket. If leaving it off is deliberate (for example a ' +
			'multi-stack deployment where another stack owns access logging), acknowledge this warning ' +
			"by calling `Annotations.of(stack).acknowledgeWarning('blocks:apigateway:access-logging-disabled')` " +
			'on the stack or backend returned by `create()`.',
	);
}

/**
 * Shared infra setup — provisions the stack-level resources that are NOT owned
 * by a compute: the shared execution role, resource groups, and console-redirect
 * routes.
 */
export function setupBlocksInfra(scope: Construct, props: BlocksBackendProps, id?: string) {
	// Fail fast with an actionable message at the create() call site if `defaults`
	// is missing (e.g. a plain-JS caller, `as any`, or a dynamically-built props
	// object) — otherwise the first Building Block to read `scope.defaults` throws
	// a cryptic `Cannot read properties of undefined (reading 'removalPolicy')`.
	if (!props.defaults) {
		throw new Error(
			'BlocksStack/BlocksBackend requires a `defaults` field. Pass a posture from ' +
				'`@aws-blocks/core/cdk` — typically `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`.',
		);
	}

	// Surface the audit-trail tradeoff at synth when running a durable posture
	// with access logging off. Non-fatal: warning only.
	warnIfDurableWithoutAccessLogging(scope, props.defaults);

	// ── Shared execution role ───────────────────────────────────────────────
	// A single IAM role that every Building Block grants to. Provisioned here so
	// it exists before the backend module is imported (Building Blocks reach it
	// via `scope.executionRole`). Block grants sit on the role's default (inline)
	// policy. AWSLambdaBasicExecutionRole is attached so compute functions retain
	// CloudWatch Logs permissions.
	//
	// INVARIANT: this must be a mutable, framework-owned `iam.Role` — never an
	// imported role (`Role.fromRoleArn`/`fromRoleName`), which is immutable by
	// default. On an immutable role, every Building Block's `grant*()` /
	// `addToPrincipalPolicy()` silently becomes a no-op (returns false, no error),
	// so permissions would quietly vanish. If a bring-your-own-role option is ever
	// added, it must resolve to a mutable role (`{ mutable: true }`).
	const executionRole = new iam.Role(scope, 'BlocksRole', {
		// CompositePrincipal (rather than a bare ServicePrincipal) so a Building Block
		// whose compute runs AS this shared role can add its own trust principal here
		// (e.g. the Agent BB adds bedrock-agentcore in its CDK construct) — core stays
		// agnostic and only Lambda is trusted by default.
		assumedBy: new iam.CompositePrincipal(new iam.ServicePrincipal('lambda.amazonaws.com')),
		managedPolicies: [
			iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
			// When Lambda is placed in a VPC it needs ENI management permissions
			...(props.defaults.vpc
				? [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')]
				: []),
		],
	});

	// ── Permissions boundary + IAM report ─────────────────────────────────
	// Cover every role AWS Blocks creates for this root (blocks-roles.ts — an
	// aspect, so roles blocks add later are covered too), then apply the opt-in
	// ceiling (`defaults.permissionsBoundary`) to that set. Unset → no-op,
	// templates unchanged. The report lists what the shared role accumulated; it is
	// written at synth (after every block has granted) beside the template.
	coverBlocksRoot(scope);
	applyBlocksPermissionsBoundary(scope);
	const owningStack = cdk.Stack.of(scope);
	attachIamReport(
		scope,
		executionRole,
		cdk.Stack.isStack(scope) ? owningStack.artifactId : `${owningStack.artifactId}.${scope.node.id}`,
	);

	// ── Resource Groups ───────────────────────────────────────────────────
	let rootStack = cdk.Stack.of(scope);
	while (rootStack.nestedStackParent) rootStack = rootStack.nestedStackParent;
	const groupPrefix = id && id !== rootStack.stackName ? `${rootStack.stackName}-${id}` : rootStack.stackName;

	new CfnGroup(scope, 'StackResources', {
		name: `${groupPrefix}-resources`,
		resourceQuery: {
			type: 'CLOUDFORMATION_STACK_1_0',
			query: {
				resourceTypeFilters: [
					'AWS::CloudWatch::Dashboard',
					'AWS::Cognito::UserPool',
					'AWS::DynamoDB::Table',
					'AWS::Logs::LogGroup',
					'AWS::RDS::DBCluster',
					'AWS::RDS::DBInstance',
					'AWS::S3::Bucket',
					'AWS::SQS::Queue',
				],
				stackIdentifier: cdk.Stack.of(scope).stackId,
			},
		},
	});

	new CfnGroup(scope, 'StackSettings', {
		name: `${groupPrefix}-settings`,
		resourceQuery: {
			type: 'TAG_FILTERS_1_0',
			query: {
				resourceTypeFilters: ['AWS::SSM::Parameter', 'AWS::SecretsManager::Secret'],
				tagFilters: [{ key: 'aws-blocks-stack', values: [rootStack.stackName] }],
			},
		},
	});

	// ── Console redirect routes ───────────────────────────────────────────
	const region = cdk.Fn.ref('AWS::Region');
	const resourcesUrl = cdk.Fn.join('', [
		'https://',
		region,
		'.console.aws.amazon.com/resource-groups/group/',
		`${groupPrefix}-resources`,
		'?region=',
		region,
	]);
	const settingsUrl = cdk.Fn.join('', [
		'https://',
		region,
		'.console.aws.amazon.com/resource-groups/group/',
		`${groupPrefix}-settings`,
		'?region=',
		region,
	]);

	registerConfig(scope, 'BB_RESOURCES_GROUP_URL', resourcesUrl);
	registerConfig(scope, 'BB_SETTINGS_GROUP_URL', settingsUrl);

	registerBuiltinRoutes();

	return { executionRole };
}

/** What {@link buildSharedGateway} reads and writes on a `BlocksStack` / `BlocksBackend`. @internal */
export interface SharedGatewayOwner extends Construct, ApiFrontDoorOwner {
	readonly _defaultCompute?: ComputeBase;
	readonly defaults: BlocksDefaults;
	_sharedGateway?: SharedGateway;
}

/**
 * Build the single shared REST API gateway for a `BlocksStack` / `BlocksBackend`
 * and record it on the owner (backs `.gateway` / `.apiUrl`). Shared by both
 * entry points' `create()` so they can't drift.
 *
 * Call once, after the backend module has imported and every compute exists.
 * The gateway's catch-all resources front the default compute's function (its
 * `apiHandler()`), and every other compute's namespaces are routed to that
 * compute's function — by export name, read from `backendModule` (see
 * `resolveNamespaceRoutes`). It is built in the default compute's construct scope, so
 * its logical IDs match the per-compute gateway it replaced — existing
 * deployments keep their REST API and `execute-api` URL. The default compute is always a Lambda compute today, so
 * `apiHandler()` is defined; a worker-only default fails with a clear error.
 *
 * Also schedules the API front door now that its origin exists. That decision is
 * deferred to synth via an aspect: a `Hosting` built after `create()` resolves
 * may claim the front-door role, in which case no managed distribution is
 * provisioned. `cloudfront` ⇒ a CloudFront distribution in front of the gateway,
 * which is then built as a `REGIONAL` endpoint; `apigateway` (the default) ⇒
 * clients call the gateway directly.
 *
 * @param backendModule the imported backend module (`backendCDKPath`) — the
 *   exports the typed client calls and the runtime dispatches against
 * @internal
 */
export function buildSharedGateway(owner: SharedGatewayOwner, backendModule: object): SharedGateway {
	const defaultCompute = owner._defaultCompute;
	if (!defaultCompute) {
		throw new Error('Default compute not initialized — create() must build it before the shared gateway.');
	}
	// createSharedGateway guards that the default compute exposes an apiHandler().
	const cloudfront = resolveApiFrontDoor(owner._apiFrontDoorTier) === 'cloudfront';
	const sharedGateway = createSharedGateway(defaultCompute, {
		// Keyed by export name, resolved from the imported backend module.
		namespaceRoutes: resolveNamespaceRoutes(backendModule, defaultCompute, getComputes(owner)),
		defaultCompute,
		defaults: owner.defaults,
		regionalEndpoint: cloudfront,
	});
	owner._sharedGateway = sharedGateway;
	scheduleApiFrontDoor(owner, cloudfront, sharedGateway.apiUrl);
	return sharedGateway;
}

/**
 * Return the owner's shared gateway, or throw the "not fully initialized" error:
 * `.gateway` / `.apiUrl` are only available once `create()` resolves (the gateway
 * is built after the backend module import).
 *
 * @internal
 */
export function requireSharedGateway(owner: SharedGatewayOwner, kind: 'BlocksStack' | 'BlocksBackend'): SharedGateway {
	if (!owner._sharedGateway) {
		const noun = kind === 'BlocksStack' ? 'stack' : 'backend';
		throw new Error(
			`Blocks ${noun} not fully initialized — access .gateway/.apiUrl after ${kind}.create() resolves.`,
		);
	}
	return owner._sharedGateway;
}

/**
 * Attach the Lambda VPC-access managed policy (`AWSLambdaVPCAccessExecutionRole`,
 * ENI management) to the shared execution role when a VPC is active on `root` —
 * provided OR derived. The role is built eagerly in {@link setupBlocksInfra} and
 * only gets this policy there when `defaults.vpc` is set; but a container compute
 * can *derive* a VPC during the backend import, and a `LambdaCompute` then
 * auto-places its function in that VPC. Without this the serverless function
 * would land in the VPC with no ENI permissions and fail at ENI creation / cold
 * start — order-dependently. Called from both `BlocksStack` and `BlocksBackend`
 * finalize. Idempotent: CDK dedupes a repeat managed policy, so it's a no-op on
 * the provided-VPC path (where the policy was already attached eagerly).
 *
 * @internal
 */
export function ensureVpcAccessPolicyWhenVpcActive(root: { executionRole: iam.IRole }): void {
	if (!isVpcInitialized(root as never)) return;
	if (root.executionRole instanceof iam.Role) {
		root.executionRole.addManagedPolicy(
			iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
		);
	}
}

/**
 * Standalone CDK construct that provisions the Blocks backend: a single Lambda
 * function fronted by one shared API Gateway REST API with RPC + catch-all proxy routing.
 *
 * Use this to embed a Blocks backend into any existing CDK stack. Building Blocks
 * instantiated during the `backendCDKPath` import will automatically attach to
 * this construct's Lambda handler.
 *
 * @example Drop into an existing stack
 * ```ts
 * const blocks = await BlocksBackend.create(myStack, 'Blocks', {
 *   backendHandlerPath: join(__dirname, 'handler.ts'),
 *   backendCDKPath: join(__dirname, 'infra.ts'),
 * });
 * // blocks.apiUrl, blocks.gateway, blocks.executionRole available
 * ```
 */
export class BlocksBackend extends Construct implements ApiFrontDoorOwner {
	public readonly backendHandlerPath: string;
	/**
	 * Path to the app's backend module (`props.backendCDKPath`). Exposed so Building Blocks that
	 * co-bundle the backend at synth (e.g. the Agent BB's AgentCore Runtime) can discover it via
	 * `globalThis.CURRENT_BLOCKS_STACK.backendModulePath`.
	 */
	public readonly backendModulePath: string;
	/** Shared IAM role assumed by all Blocks compute. Building Blocks grant to this role. */
	public readonly executionRole: iam.IRole;
	/** Infrastructure defaults for Building Blocks created under this backend. */
	public readonly defaults: BlocksDefaults;
	/** The default compute (owns the Lambda function); set in `create()`. @internal */
	_defaultCompute?: ComputeBase;
	/** The single shared REST API gateway fronting the default compute; built in `create()`. @internal */
	_sharedGateway?: SharedGateway;
	/** Set when a `Hosting` distribution has claimed the API front-door role (see {@link claimApiFrontDoor}). @internal */
	_apiFrontDoorClaimedByHosting?: boolean;
	/** Public origin of whichever front door ended up fronting the API. @internal */
	_apiFrontDoorResolvedUrl?: string;
	/** Set when `Hosting` published the browser-facing origin (see {@link publishPublicOrigin}). @internal */
	_publicOriginPublishedByHosting?: boolean;
	/** The resolved `apiFrontDoor` tier; set in the constructor, before the backend module is imported. @internal */
	_apiFrontDoorTier?: ApiFrontDoorTier;

	/**
	 * Claim the API front-door role for a `Hosting` distribution fronting this
	 * backend's API, so the managed `cloudfront` distribution stands down. Recorded
	 * on this instance (not ambient per-stack state) — see {@link ApiFrontDoorOwner}.
	 * @internal Framework-only.
	 */
	claimApiFrontDoor(distributionUrl: string): void {
		claimApiFrontDoor(this, distributionUrl);
	}

	/**
	 * Record that a `Hosting` door publishes this backend's browser-facing origin
	 * (`BLOCKS_PUBLIC_ORIGIN`), so the managed `cloudfront` distribution doesn't
	 * overwrite it. See {@link publishPublicOrigin}.
	 * @internal Framework-only.
	 */
	publishPublicOrigin(): void {
		publishPublicOrigin(this);
	}

	/** The backend's shared REST API gateway. To be removed once consumers move to the multi-compute model. */
	get gateway(): apigateway.RestApi {
		return this.requireSharedGateway().restApi;
	}
	/**
	 * The shared gateway's own RPC endpoint URL (its `execute-api` address),
	 * whatever the `apiFrontDoor` tier. `Hosting` forwards API traffic to it, so it
	 * stays the gateway's URL even under `'cloudfront'`. For the URL clients should
	 * call, use {@link publicApiUrl}. To be removed once consumers move to the
	 * multi-compute model.
	 */
	get apiUrl(): string {
		return this.requireSharedGateway().apiUrl;
	}
	/**
	 * The URL clients should send RPC calls to: the CloudFront distribution's URL +
	 * `/aws-blocks/api` under `apiFrontDoor: 'cloudfront'` (the managed
	 * distribution, or `Hosting`'s when Hosting fronts the API), otherwise
	 * {@link apiUrl}. A CloudFormation token, resolved at synth — use it wherever a
	 * deploy-time value works (a `CfnOutput`, Amplify outputs, …).
	 */
	get publicApiUrl(): string {
		return publicApiUrl(this, () => this.apiUrl);
	}
	/** The default compute's handler CloudWatch log group. Its retention comes from
	 * the compute's `logRetention` (falling back to `defaults.logRetention`); the
	 * `bb-logger` CDK construct is a no-op and no longer touches it. */
	get handlerLogGroup(): cdk.aws_logs.ILogGroup {
		return this.requireDefaultCompute().logGroup;
	}

	private requireDefaultCompute(): LambdaShapedCompute {
		if (!this._defaultCompute) {
			throw new Error(
				'Blocks backend not fully initialized — access .gateway/.apiUrl after BlocksBackend.create() resolves.',
			);
		}
		return this._defaultCompute as LambdaShapedCompute;
	}

	private requireSharedGateway(): SharedGateway {
		return requireSharedGateway(this, 'BlocksBackend');
	}

	/**
	 * The fullId used by child Scopes to compute their env var names,
	 * construct IDs, and physical resource names (e.g., DynamoDB table names).
	 *
	 * Includes the CDK stack name to ensure physical resources are unique
	 * per deployment. This matches what the runtime sees via BLOCKS_STACK_NAME.
	 *
	 * IMPORTANT: this value MUST be token-free. Child Scopes embed `fullId` in
	 * CDK construct IDs (e.g. `${fullId}DsqlMigrationFn`), and CDK forbids
	 * unresolved tokens in construct IDs ("ID components may not include
	 * unresolved tokens"). It is also used to build env-var keys that must match
	 * byte-for-byte between synth time and runtime.
	 *
	 * A nested stack (e.g. Amplify Gen2 `backend.createStack('blocks')`) has a
	 * tokenized `stackName` that only resolves at deploy time. We therefore walk
	 * up to the top-level stack, whose name is concrete at synth time and still
	 * unique per deployment. The `Token.isUnresolved` guard is a defensive
	 * fallback to the (token-free) construct id should no resolvable name exist.
	 */
	get fullId(): string {
		let stack = cdk.Stack.of(this);
		while (stack.nestedStackParent) {
			stack = stack.nestedStackParent;
		}
		const stackName = stack.stackName;
		if (cdk.Token.isUnresolved(stackName)) {
			return this.node.id;
		}
		return `${stackName}-${this.node.id}`;
	}

	private _vpcOptions?: BlocksVpcOptions;

	private constructor(scope: Construct, id: string, props: BlocksBackendProps) {
		super(scope, id);

		this.backendHandlerPath = props.backendHandlerPath;
		this.backendModulePath = props.backendCDKPath;
		this._vpcOptions = props.defaults.vpc;
		// Validate and record the tier before the backend module is imported, so an
		// invalid value fails before any app code runs.
		this._apiFrontDoorTier = resolveApiFrontDoor(props.apiFrontDoor);

		// Brand as a backend root so getBlocksRoot() finds this by walking the
		// construct tree — the key that keeps two BlocksBackends in one cdk.Stack
		// independent (see root-registry.ts). Set before any child BB is built.
		(this as unknown as Record<symbol, boolean>)[BLOCKS_BACKEND_ROOT] = true;

		// Expose self to Building Blocks at CDK time
		(globalThis as any).CURRENT_BLOCKS_STACK = this;

		// Store defaults on the backend (not the stack) so several BlocksBackends
		// in one stack each keep their own posture; Building Blocks resolve them by
		// walking up to their owning backend (see Scope.defaults).
		this.defaults = props.defaults;

		// Initialize VPC context before the default compute is created and before
		// BBs are constructed, so both can discover it: the default compute
		// (LambdaCompute) reads it via getVpcContext(this) to place its function in
		// the VPC, and BBs (e.g. bb-data) read it to co-locate their resources.
		if (this._vpcOptions) {
			initializeVpc(this, this._vpcOptions);
		}

		const infra = setupBlocksInfra(this, props, id);
		this.executionRole = infra.executionRole;

		// A committed baseline whose block left the app (renamed or removed) would
		// let CloudFormation delete the resource it guards. Checked here, not by
		// the block, so it still runs when no instance of the block is left. Keyed
		// by `fullId`, the backend's BLOCKS_STACK_NAME (resolved at validation).
		addOrphanedBaselineCheck(this, props.backendHandlerPath, () => this.fullId);

		// The default compute (and thus handler/gateway) is created in create(),
		// after construction — it derives BLOCKS_STACK_NAME from this.fullId.
	}

	static async create(scope: Construct, id: string, props: CoreBlocksBackendProps) {
		assertCdkConditionActive();
		// Stack-level children before this backend exists, so the boundary can also
		// cap the per-stack CDK singletons its blocks add (see the end of create()).
		const stackChildrenBefore = snapshotChildren(cdk.Stack.of(scope));
		const backend = new BlocksBackend(scope, id, props);
		// Create the default compute before importing the backend: it owns the
		// Lambda function (the shared gateway's target), and a block reading
		// `this.compute` in its constructor (during that import) must resolve to
		// it. The factory is supplied by the umbrella
		// @aws-blocks/blocks (which injects LambdaCompute) via props, so core never
		// imports the concrete compute class.
		backend._defaultCompute = props.defaultComputeFactory(backend);
		// file:// URL (not a raw path) so the cache-busting query works on Windows,
		// where an absolute path like `D:\...` is rejected as URL scheme `d:`.
		const backendUrl = pathToFileURL(props.backendCDKPath);
		backendUrl.searchParams.set('stack', id);
		// Propagate the synth-time deployment type to deployed compute (via the BB
		// config) and to this synth process, before the backend module imports so
		// blocks can read getDeploymentType() during construction. The CDK context
		// is authoritative at synth, so this overwrites any inherited value here.
		// On deployed compute getDeploymentType() reads only the BB config entry,
		// so an environment variable set on the compute cannot override it.
		const deploymentType = isSandboxContext(backend) ? 'sandbox' : 'production';
		registerConfig(backend, 'BLOCKS_DEPLOYMENT_TYPE', deploymentType);
		process.env.BLOCKS_DEPLOYMENT_TYPE = deploymentType;
		const mod = await import(backendUrl.href);
		if (typeof mod.default === 'function') {
			try {
				await mod.default(backend);
			} catch (error) {
				throw new Error(
					`Error executing default export function for backend "${id}": ${error instanceof Error ? error.message : error}`,
					{ cause: error },
				);
			}
		}
		addBlocksStackMetadata(cdk.Stack.of(backend));

		// Build the single shared REST API gateway now that the backend module has
		// imported and every compute exists, and schedule the API front door
		// (see buildSharedGateway).
		buildSharedGateway(backend, mod);

		// Finalize BB config → S3 (after all BBs have registered their config)
		finalizeConfigRegistry(backend, backend.executionRole, getComputes(backend));

		// Tracing is presence-gated: if the app contains a Tracer, enable X-Ray on
		// every compute. Runs before the dashboard finalize.
		finalizeTracing(backend, backend.executionRole);

		// Build any deferred Dashboards now that every compute's observability
		// state is settled — so the dashboard is order-independent.
		finalizeDashboards(backend);

		// Per-compute finalize hook: wiring that needs the fully-imported backend
		// (e.g. a container's queue-depth autoscaling, which must know every
		// AsyncJob queue assigned to it).
		for (const compute of getComputes(backend)) compute.finalize();

		// Finalize VPC. Derived resource: use the customer's if provided, else
		// lazily create one only if a Building Block requires it.
		//
		// A container compute may have already derived + initialized the shared VPC
		// during the backend import (it needs the VPC at construction), so skip
		// re-initializing when that happened but still run finalizeVpc for endpoints.
		if (backend._vpcOptions) {
			finalizeVpc(backend, backend._vpcOptions);
		} else if (isVpcInitialized(backend)) {
			finalizeVpc(backend, { network: getOrCreateVpc(backend) });
		} else if (anyRequirementNeedsVpc(backend)) {
			const derived = getOrCreateVpc(backend);
			const options = { network: derived };
			initializeVpc(backend, options);
			finalizeVpc(backend, options);
			cdk.Annotations.of(backend).addInfoV2(
				'blocks:vpc:derived',
				'A Building Block required a VPC and none was provided, so Blocks created one ' +
					'(with a NAT gateway, which has an ongoing cost). Pass `defaults.vpc: { network }` to ' +
					'bring your own. See packages/blocks/VPC.md.',
			);
		}

		// A LambdaCompute auto-places its function in whatever VPC is initialized on
		// the backend — including one a container sibling *derived* during the import.
		// Ensure the shared role carries ENI permissions in that case (see helper).
		ensureVpcAccessPolicyWhenVpcActive(backend);

		// Last, so every role a block or finalizer hoisted to stack scope exists.
		coverStackLevelAdditions(backend, stackChildrenBefore);
		warnOnMixedBoundaries(backend);

		return backend;
	}
}
