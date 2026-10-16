// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard API v1 contract (API v0 of the product, served under /api/v1).
 *
 * These types are the single source of truth for the HTTP contract between
 * the Admin UI SPA and whatever backend serves it (local Node server today,
 * in-account Lambda later). The SPA never talks to AWS directly — it only
 * talks to this API, which delegates to a swappable {@link DataProvider}.
 */

export const API_VERSION = 1;

/** GET /api/v1/meta */
export interface MetaResponse {
	apiVersion: typeof API_VERSION;
	/** Version of the @aws-blocks/admin-ui package serving the UI. */
	adminUiVersion: string;
	/** Project name (from the app's package.json). */
	projectName: string;
	/** Absolute path of the Blocks app the dashboard was started from. */
	projectRoot: string;
	/** Stages known to the dashboard. Blocks today knows sandbox + production. */
	stages: StageInfo[];
}

export interface StageInfo {
	/** Stage name, e.g. "sandbox" or "production". */
	name: string;
	/** CloudFormation stack name, when resolvable from .blocks config. */
	stackName?: string;
}

/** A single deployment record. Primary source: .blocks/deploy-history.jsonl (M1). */
export interface DeploymentRecord {
	/** Unique id for the deployment (client-generated at deploy time). */
	id: string;
	stage: string;
	/** ISO-8601 start timestamp. */
	startedAt: string;
	/** ISO-8601 end timestamp; absent while in progress. */
	finishedAt?: string;
	status: DeploymentStatus;
	/** Where this record came from. CFN-derived records are reconstructed. */
	source: 'deploy-history' | 'cloudformation-events';
	/** Git SHA if it was recorded at deploy time (core stamping is pending). */
	gitSha?: string;
	/** Human-readable error summary for failed deployments. */
	errorSummary?: string;
	/** AWS region the deploy targeted, recorded at deploy time. */
	region?: string;
	/** CloudFormation stack name, recorded at deploy time. */
	stackName?: string;
}

export type DeploymentStatus = 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK' | 'UNKNOWN';

/** GET /api/v1/deployments?stage=<name> */
export interface DeploymentsResponse {
	apiVersion: typeof API_VERSION;
	deployments: DeploymentRecord[];
}

/**
 * A CloudFormation resource event relevant to failure analysis.
 * Sourced from DescribeStackEvents within the deployment's time window.
 */
export interface FailureEvent {
	/** ISO-8601 event timestamp. */
	timestamp: string;
	logicalResourceId: string;
	resourceType: string;
	/** e.g. CREATE_FAILED, UPDATE_FAILED, UPDATE_ROLLBACK_IN_PROGRESS. */
	resourceStatus: string;
	statusReason?: string;
	/** True for cascade noise like "Resource creation cancelled". */
	cancelled: boolean;
}

/** GET /api/v1/deployments/:id */
export interface DeploymentDetailResponse {
	apiVersion: typeof API_VERSION;
	deployment: DeploymentRecord;
	/** Stack name the events were fetched for, when resolvable. */
	stackName?: string;
	/**
	 * Where the failure events came from:
	 * - cloudformation: fetched live from DescribeStackEvents
	 * - unavailable: could not fetch (no credentials, stack gone, not deployed)
	 * - not-applicable: deployment did not fail — no events fetched
	 */
	eventsSource: 'cloudformation' | 'unavailable' | 'not-applicable';
	/** Human-readable reason when eventsSource is 'unavailable'. */
	eventsError?: string;
	/**
	 * Machine-readable classification of eventsError, for targeted UX:
	 * - CREDENTIALS_EXPIRED: refresh credentials and retry, no restart needed
	 * - CREDENTIALS_MISSING: no credentials resolvable at all
	 * - STACK_NOT_FOUND: often a region mismatch, check awsContext.region
	 * - UNKNOWN: anything else
	 */
	eventsErrorCode?: 'CREDENTIALS_EXPIRED' | 'CREDENTIALS_MISSING' | 'STACK_NOT_FOUND' | 'UNKNOWN';
	/** What the server actually resolved for the AWS call — the debugging hint. */
	awsContext?: {
		/** AWS_PROFILE of the dashboard server process, if set. */
		profile?: string;
		/** Region used for the events query. */
		region?: string;
		/**
		 * Which tier supplied the region:
		 * - cli: the dashboard's own `--region` flag (beats everything)
		 * - env: AWS_REGION / AWS_DEFAULT_REGION
		 * - outputs: that stage's own CDK outputs document (CDK's own answer)
		 * - none: no tier supplied one, so no region was verified
		 *
		 * `deploy-record` is deliberately gone: the region recorded at deploy time
		 * was re-derived through a resolver that can disagree with the region CDK
		 * deployed to, and a wrong value there was indistinguishable from a right
		 * one. Nothing resolves a region from the deploy history any more.
		 */
		regionSource?: 'cli' | 'env' | 'outputs' | 'none';
	};
	/** Failure events in the deploy window, newest first. */
	failureEvents: FailureEvent[];
	/** The most likely root cause: the FIRST non-cancelled failure event. */
	rootCause?: FailureEvent;
}

/** Error envelope returned by all /api/v1 routes on failure. */
export interface ApiError {
	apiVersion: typeof API_VERSION;
	error: {
		code: 'UNAUTHORIZED' | 'NOT_FOUND' | 'PROVIDER_ERROR' | 'BAD_REQUEST' | 'LOCKED' | 'CONFLICT';
		message: string;
	};
}

/** A CloudWatch log group belonging to the app's stack. */
export interface LogGroupInfo {
	/** Log group name, e.g. /aws/lambda/my-app-handler. */
	name: string;
	/**
	 * How the group was discovered:
	 * - explicit: an AWS::Logs::LogGroup resource in the stack
	 * - lambda: derived from an AWS::Lambda::Function (/aws/lambda/<fn>)
	 */
	source: 'explicit' | 'lambda';
	/** Logical id of the stack resource this group belongs to. */
	logicalResourceId: string;
	resourceType: string;
	/** Enrichment from CloudWatch Logs, when available. null = never expires; absent = unknown (enrichment failed). */
	retentionDays?: number | null;
	storedBytes?: number;
}

/** GET /api/v1/logs/groups?stage=<name> */
export interface LogGroupsResponse {
	apiVersion: typeof API_VERSION;
	stage: string;
	/** Stack the groups were discovered from, when resolvable. */
	stackName?: string;
	/** cloudformation = discovered live; unavailable = could not list resources. */
	groupsSource: 'cloudformation' | 'unavailable';
	groupsError?: string;
	groupsErrorCode?: 'CREDENTIALS_EXPIRED' | 'CREDENTIALS_MISSING' | 'STACK_NOT_FOUND' | 'UNKNOWN';
	awsContext?: DeploymentDetailResponse['awsContext'];
	groups: LogGroupInfo[];
}

/** Facet + query parameters for log search (bb-logger JSON fields). */
export interface LogSearchParams {
	stage: string;
	/** Free-text match against the raw message. */
	text?: string;
	/** bb-logger level facet (debug | info | warn | error). */
	level?: string;
	/** bb-logger logger-id facet, substring match. */
	logger?: string;
	/** X-Ray trace id facet, exact match. */
	traceId?: string;
	/** Restrict the search to one log group (exact name, from discovery). */
	group?: string;
	/** ISO-8601 range start. Default: 1 hour ago. */
	start?: string;
	/** ISO-8601 range end. Default: now. */
	end?: string;
	/** Max results. Default 100, cap 1000. */
	limit?: number;
}

/** One matched log event. bb-logger fields are parsed when present. */
export interface LogEntry {
	/** Event timestamp (ISO-8601). */
	timestamp: string;
	/** Raw message line. */
	message: string;
	logGroup: string;
	logStream?: string;
	/** Parsed bb-logger fields; absent for non-JSON/non-bb-logger lines. */
	level?: string;
	logger?: string;
	traceId?: string;
}

/** GET /api/v1/logs/search?stage=&text=&level=&logger=&traceId=&start=&end=&limit= */
export interface LogSearchResponse {
	apiVersion: typeof API_VERSION;
	stage: string;
	/** insights = ran via CloudWatch Logs Insights; unavailable = could not run. */
	searchSource: 'insights' | 'unavailable';
	searchError?: string;
	searchErrorCode?: 'CREDENTIALS_EXPIRED' | 'CREDENTIALS_MISSING' | 'STACK_NOT_FOUND' | 'QUERY_TIMEOUT' | 'UNKNOWN';
	awsContext?: DeploymentDetailResponse['awsContext'];
	/** Log groups the query actually spanned. */
	queriedGroups: string[];
	entries: LogEntry[];
	/** Insights scan statistics — surfaced because scans cost money. */
	stats?: {
		scannedBytes?: number;
		matchedEvents?: number;
	};
}

/** A CloudFormation resource, joined with its CDK construct path. */
export interface ResourceInfo {
	logicalResourceId: string;
	resourceType: string;
	physicalResourceId?: string;
	/** CloudFormation resource status, e.g. CREATE_COMPLETE. */
	resourceStatus?: string;
	/** aws:cdk:path metadata (stack-name segment stripped), when present. */
	cdkPath?: string;
	/** Human label for the type, e.g. 'DynamoDB Table'. */
	typeLabel?: string;
	/**
	 * Deep link into the AWS console. Only emitted for resource types with a
	 * genuinely useful console page: a confident link to nothing is worse than
	 * no link, and console routes are not a contract.
	 */
	consoleUrl?: string;
	/** False when consoleUrl points at the stack rather than the resource itself. */
	directLink?: boolean;
}

/** Resources grouped by the construct that owns them. */
export interface ResourceGroup {
	/** Group id: block path for app blocks (e.g. "my-app/auth"), construct name otherwise. */
	id: string;
	/**
	 * - app: a block instantiated by the user's foundation
	 * - platform: Blocks-owned constructs (KitStack internals, API, handler)
	 * - cdk: CDK bookkeeping (custom-resource providers, metadata)
	 */
	category: 'app' | 'platform' | 'cdk';
	resources: ResourceInfo[];
	/**
	 * Set when this group was matched to a block from GET /api/v1/blocks.
	 * Attribution still comes from the deployed template — source discovery only
	 * supplies the label, so a block declared but not shipped is never claimed.
	 */
	blockFullId?: string;
	blockType?: string;
}

/** GET /api/v1/resources?stage=<name> */
export interface ResourcesResponse {
	apiVersion: typeof API_VERSION;
	stage: string;
	stackName?: string;
	resourcesSource: 'cloudformation' | 'unavailable';
	resourcesError?: string;
	resourcesErrorCode?: 'CREDENTIALS_EXPIRED' | 'CREDENTIALS_MISSING' | 'STACK_NOT_FOUND' | 'UNKNOWN';
	awsContext?: DeploymentDetailResponse['awsContext'];
	groups: ResourceGroup[];
	totalResources: number;
}

/** One day of cost. */
export interface CostDay {
	/** ISO date (YYYY-MM-DD). */
	date: string;
	amount: number;
}

/** Cost attributed to one AWS service. */
export interface CostService {
	service: string;
	amount: number;
}

/**
 * GET /api/v1/cost?stage=<name>
 *
 * Attribution ladder (best available wins):
 * - stack-tag: filtered by the aws:cloudformation:stack-name cost
 *   allocation tag — exactly this app's stack
 * - deployment-type-tag: filtered by blocks:deployment-type — ALL Blocks
 *   deployments of that stage in the account
 * - account-unattributed: no usable tag active — whole-account totals,
 *   honestly labeled
 */
export interface CostResponse {
	apiVersion: typeof API_VERSION;
	stage: string;
	costSource: 'cost-explorer' | 'unavailable';
	costError?: string;
	costErrorCode?: 'CREDENTIALS_EXPIRED' | 'CREDENTIALS_MISSING' | 'ACCESS_DENIED' | 'UNKNOWN';
	awsContext?: DeploymentDetailResponse['awsContext'];
	attribution?: 'stack-tag' | 'deployment-type-tag' | 'account-unattributed';
	/** Stack the costs are (or should be) attributed to. */
	stackName?: string;
	currency?: string;
	/** Daily costs, oldest first (30 days). */
	days: CostDay[];
	total?: number;
	/** By-service breakdown for the period, largest first. */
	byService: CostService[];
	/**
	 * Cost allocation tag activation state — activation happens in the
	 * billing console, needs billing permissions, and backfills ~24h later.
	 */
	tags?: {
		stackNameTagActive: boolean;
		deploymentTypeTagActive: boolean;
	};
	/** When this result was fetched (responses are cached — CE requests cost $0.01 each). */
	fetchedAt?: string;
}

/** What a usage refresh will cost, and the arithmetic behind it. */
export interface UsageCostEstimate {
	/** Billed metric requests: the figure the rate applies to. */
	metricsRequested: number;
	/** GetMetricData calls the fetch needs. NOT the billed unit. */
	apiCalls: number;
	/** Estimated charge in USD. */
	usd: number;
	/** Pre-formatted, so a sub-cent charge never renders as `$0.00`. */
	usdFormatted: string;
	/** The rate the estimate used, so the view cites it instead of restating it. */
	usdPer1000Metrics: number;
	/**
	 * Always true: GetMetricData is one of three CloudWatch operations the free
	 * tier excludes, so there is no allowance for this view to fall inside. A
	 * field rather than prose, so no caller can imply a free tier.
	 */
	alwaysCharged: true;
}

/** One resource the usage view would query, for the consent screen's inventory. */
export interface UsageTargetInfo {
	kind: 'api' | 'function' | 'table' | 'workflow' | 'topic' | 'cdn';
	label: string;
	namespace: string;
	/** Metrics this target contributes to the billed total. */
	metricCount: number;
	/** Region this target is read from: CloudFront differs from the stack's. */
	region: string;
	/** True when the dimensions are not unique to this stage. */
	sharedDimensions?: true;
	/** Why they are shared, shown verbatim so the view invents no wording. */
	sharedReason?: string;
}

/** One datapoint of a usage series. */
export interface UsagePointInfo {
	timestamp: string;
	value: number;
}

/** One metric's time series for one resource. */
export interface UsageSeriesInfo {
	/** Stable key of the target, so several series group under one resource. */
	targetKey: string;
	targetLabel: string;
	targetKind: UsageTargetInfo['kind'];
	metricName: string;
	stat: string;
	namespace: string;
	/** Oldest first. */
	points: UsagePointInfo[];
	total: number;
	sharedDimensions?: true;
	/**
	 * CloudWatch returned no datapoints at all. Distinct from a series of
	 * zeroes: "never recorded anything" and "recorded zero" both draw a flat
	 * line, and only this flag lets the view say which it is.
	 */
	empty?: true;
}

/** Headline figures across a stage's series. */
export interface UsageTotalsInfo {
	invocations: number;
	errors: number;
	emptySeries: number;
	seriesCount: number;
	/** A contributing series spans more than this stage, so the total is not exact. */
	includesSharedDimensions?: true;
}

/**
 * GET /api/v1/usage?stage=&rangeMinutes=&confirm=
 *
 * THE CONSENT GATE, and why `confirm` is a request parameter rather than
 * server-side session state like the write unlock:
 *
 * Without `confirm=true` the route does NOT call GetMetricData. It answers
 * `usageSource: 'gated'` carrying the estimate and the target inventory, so the
 * user authorises a priced request rather than a vague one. Discovery itself
 * (CloudFormation ListStackResources and GetTemplate) carries no per-request
 * charge, which is what makes the gate genuinely free rather than merely
 * cheaper.
 *
 * The write unlock is per-session because it governs a standing capability. A
 * usage refresh is one priced action, so the consent belongs to the REQUEST:
 * it cannot be inherited by a later call, cannot drift out of step with the
 * estimate the user actually saw, and leaves no state to get stale.
 */
export interface UsageResponse {
	apiVersion: typeof API_VERSION;
	stage: string;
	/**
	 * - gated: nothing was fetched and nothing billed; `estimate` says what it would cost
	 * - cloudwatch: metrics were fetched and billed
	 * - unavailable: could not be read at all
	 */
	usageSource: 'gated' | 'cloudwatch' | 'unavailable';
	usageError?: string;
	usageErrorCode?: 'CREDENTIALS_EXPIRED' | 'CREDENTIALS_MISSING' | 'ACCESS_DENIED' | 'STACK_NOT_FOUND' | 'UNKNOWN';
	awsContext?: DeploymentDetailResponse['awsContext'];
	/** Stack the metrics are attributed to. */
	stackName?: string;
	/** Window requested, echoed so a chart's axis matches what was asked for. */
	rangeMinutes: number;
	/** Resolution the range resolved to, in seconds. */
	periodSeconds: number;
	start?: string;
	end?: string;
	/** Present in every state, including `gated` — it is the gate's whole point. */
	estimate: UsageCostEstimate;
	/** What would be (or was) queried. */
	targets: UsageTargetInfo[];
	/** Present only when `usageSource` is `cloudwatch`. */
	series?: UsageSeriesInfo[];
	totals?: UsageTotalsInfo;
	fetchedAt?: string;
}

/** One stage's deployment environment, read-only. */
export interface EnvironmentInfo {
	stage: string;
	stackName?: string;
	/**
	 * Region this stage resolved to — PER STAGE, not per response. The sandbox and
	 * production read separate CDK outputs documents, so they can legitimately sit
	 * in different regions at the same time.
	 */
	region?: string;
	/** Which tier supplied `region`; see `awsContext.regionSource`. */
	regionSource?: 'cli' | 'env' | 'outputs' | 'none';
	/**
	 * - deployed: stack exists (stackStatus carries the CFN state)
	 * - not-deployed: we looked in a named region and found nothing, or nothing
	 *   local names a deployment at all
	 * - unknown: we could not look, or could not vouch for where we looked
	 */
	state: 'deployed' | 'not-deployed' | 'unknown';
	/**
	 * Why the state is what it is, in a sentence that names the region looked in
	 * and the remedy. Set on every `not-deployed` and on an `unknown` that is not
	 * an AWS failure (those carry `error` instead).
	 *
	 * This exists so the UI can never render a bare "not deployed": the defect it
	 * replaces said exactly that about a `CREATE_COMPLETE` stack, because the
	 * lookup had gone to the wrong region and nothing in the payload said which
	 * region that was.
	 */
	stateReason?: string;
	stackStatus?: string;
	/** ISO-8601: last update (or creation) time of the stack. */
	lastUpdated?: string;
	/** Last known drift status (from prior drift detection; never triggers one). */
	driftStatus?: string;
	/** ISO-8601 timestamp of the last drift check, if any ever ran. */
	driftCheckedAt?: string;
	/** Selected stack outputs (ApiUrl and hosting URL when present). */
	outputs?: Record<string, string>;
	/** AWS console deep link to the stack. */
	consoleUrl?: string;
	error?: string;
}

/** GET /api/v1/environments */
export interface EnvironmentsResponse {
	apiVersion: typeof API_VERSION;
	awsContext?: DeploymentDetailResponse['awsContext'];
	environments: EnvironmentInfo[];
}

/**
 * GET /api/v1/logs/tail?stage=&level= — an ndjson STREAM, one TailMessage
 * per line, not a JSON envelope. Sessions are capped (2 concurrent, 10 log
 * groups, 15 min max) because CloudWatch Live Tail bills per session-minute.
 */
export type TailMessage =
	| { type: 'session'; groups: string[]; startedAt: string; maxDurationMs: number }
	| { type: 'event'; entry: LogEntry }
	| { type: 'end'; reason: 'max-duration' | 'client-disconnect' | 'stream-closed' }
	| {
			type: 'error';
			message: string;
			code: 'SESSION_LIMIT' | 'CREDENTIALS_EXPIRED' | 'CREDENTIALS_MISSING' | 'UNKNOWN';
	  };

/*
 * ---------------------------------------------------------------------------
 * Developer pillars: blocks, data, writes, rpc, doctor.
 *
 * Everything above this line answers "what is deployed and how is it behaving"
 * from CloudFormation/CloudWatch/Cost Explorer. Everything below answers "what
 * did I declare, what is in it, and does it work" — the developer axis. See
 * DESIGN.md for the capability map and the decisions behind these shapes.
 * ---------------------------------------------------------------------------
 */

/**
 * The AWS-failure classification shared by every pillar that calls AWS.
 * The pillars above predate this alias and keep their inline unions; new
 * responses use it so the set stays in one place.
 */
export type AwsErrorCode = 'CREDENTIALS_EXPIRED' | 'CREDENTIALS_MISSING' | 'STACK_NOT_FOUND' | 'UNKNOWN';

/**
 * Category a block belongs to, for grouping in the UI.
 *
 * `unknown` is load-bearing: a `new X(scope, 'id')` that looks like a block
 * but is not a recognised type is reported as unknown rather than dropped, so
 * a third-party or newly-added block shows up as a gap instead of vanishing.
 */
export type BlockCategory =
	| 'core'
	| 'auth'
	| 'data'
	| 'storage'
	| 'messaging'
	| 'compute'
	| 'ai'
	| 'config'
	| 'observability'
	| 'hosting'
	| 'unknown';

/** One parameter of an API method, as declared in the user's source or spec. */
export interface ApiMethodParam {
	name: string;
	/** TypeScript type text when resolvable (spec-derived), else absent. */
	type?: string;
	optional?: boolean;
}

/** A method exposed by an ApiNamespace block. */
export interface ApiMethod {
	name: string;
	params: ApiMethodParam[];
}

/** DynamoDB-style key schema of a table-backed block. */
export interface BlockKeySchema {
	partitionKey: string;
	sortKey?: string;
}

/**
 * Where an AppSetting's SSM parameter path came from.
 *
 * `unresolved` is not an error state: `AppSetting.fromExisting` REQUIRES an
 * explicit `name`, and the documented way to pass one is a variable holding a
 * name seeded outside the stack (`ensureSecrets`). So the most important
 * settings are exactly the ones whose path a source scan cannot name, and a
 * consumer must address those from the deployed stack instead of guessing
 * `/${fullId}`, which is the one answer that is certainly wrong when an
 * explicit name was given.
 */
export type SettingNameSource = 'derived' | 'explicit' | 'unresolved';

/**
 * AppSetting only: the declaration-side facts a settings editor needs.
 *
 * Source-derived like everything else in {@link DiscoveredBlock}, so it says
 * what the app DECLARES and nothing about what is deployed or what any stage
 * currently holds.
 */
export interface BlockSettingDeclaration {
	/**
	 * SSM parameter path. Present when `nameSource` is `derived` (`/${fullId}`,
	 * the framework default) or `explicit` (a string literal in the source), and
	 * absent only for `unresolved`.
	 */
	parameterName?: string;
	nameSource: SettingNameSource;
	/**
	 * Declared `secret: true`, so the parameter is a SecureString and its value
	 * is never listed in cleartext. Read independently of the name: a secret
	 * whose path we could not resolve must still be KNOWN to be a secret, since
	 * losing this flag is the one failure that leaks a value.
	 */
	secret: boolean;
	/**
	 * A Standard Schema is configured, so the app validates every `put()`
	 * against it. A dashboard write cannot run that schema (it lives in app
	 * source, not in the parameter), so this flag is what lets the UI say so
	 * rather than imply a validation it did not perform.
	 */
	hasSchema: boolean;
	/**
	 * Declared with `AppSetting.fromExisting`, so the parameter is created and
	 * owned outside this stack. It is absent from the deployed template, and the
	 * app holds `ssm:GetParameter` on it but not `ssm:PutParameter`.
	 */
	external: boolean;
}

/** The `new Scope('id', ...)` that owns every block in the project. */
export interface ScopeInfo {
	id: string;
	/** Path relative to projectRoot. */
	file: string;
	line: number;
}

/** A block declared in the app's `aws-blocks/` source. */
export interface DiscoveredBlock {
	/** Block class name, e.g. 'DistributedTable'. */
	type: string;
	/** Second constructor argument, e.g. 'pages'. */
	id: string;
	/** Scope-qualified id (`<scopeId>-<id>`), which is how physical resources are named. */
	fullId: string;
	category: BlockCategory;
	/**
	 * One-line description of what this block TYPE does — the opening sentence of
	 * the block package's own README, carried through the generated block
	 * catalog. Plain text, and not truncated, so a caller that has to fit it into
	 * a fixed space clamps it for display and keeps the full text for a tooltip.
	 *
	 * Absent for a block whose package exports several block classes (the README
	 * then describes the package, not the class) and for an unrecognised type.
	 * A consumer must therefore treat it as optional garnish and never as the
	 * only thing identifying a block: `type` and `id` do that.
	 */
	description?: string;
	/** Path relative to projectRoot. */
	file: string;
	line: number;
	/** Source text of the config object literal, truncated. */
	configPreview?: string;
	/** ApiNamespace only. */
	methods?: ApiMethod[];
	/** Table-backed blocks only, when statically resolvable. */
	keySchema?: BlockKeySchema;
	/** AppSetting only. */
	setting?: BlockSettingDeclaration;
}

/*
 * A note on what is deliberately NOT here: a `resourceGroupIds` field.
 *
 * One existed, documented as "resource-group ids from GET /api/v1/resources this
 * block was matched to". Nothing ever wrote it and nothing ever read it, because
 * the deployed-vs-declared join belongs on the resources side: `/api/v1/blocks`
 * is a pure source scan that needs no credentials and works with nothing
 * deployed, which is what lets the Blocks page and the doctor function offline.
 * `ResourceGroup.blockFullId` carries the join, and the client correlates the two.
 *
 * It was removed rather than left in place because of the standard the write
 * contract already sets for itself: a field that advertises a value the server
 * never sends is a lie in the type, and this one invited a future reader to wire
 * a feature to a field that would always be undefined.
 */

/**
 * A construct that pattern-matches a block declaration but was not recognised.
 * Reported rather than skipped so an unrecognised block type is visible.
 */
export interface UnknownConstruct {
	/** Callee text as written, e.g. 'blocks.SomeNewBlock'. */
	text: string;
	file: string;
	line: number;
	/** Why it was not resolved to a block. */
	reason: 'unknown-type' | 'non-literal-id' | 'aliased-import';
}

/** GET /api/v1/blocks — source-derived inventory of what the app declares. */
export interface BlocksResponse {
	apiVersion: typeof API_VERSION;
	blocksSource: 'source-scan' | 'unavailable';
	blocksError?: string;
	blocksErrorCode?: 'NOT_A_BLOCKS_PROJECT' | 'PARSE_FAILED' | 'UNKNOWN';
	projectName: string;
	scope?: ScopeInfo;
	blocks: DiscoveredBlock[];
	unknownConstructs: UnknownConstruct[];
	/** Files parsed, so a suspiciously empty result is diagnosable. */
	scannedFiles: number;
}

/** Where a data page was read from. */
export type DataMode = 'local' | 'cloud';

/** One physical store a block can be read from. A block may shard across several. */
export interface DataStore {
	/** Opaque id passed back as ?store=. */
	id: string;
	label: string;
	kind: 'bb-data-file' | 'dynamodb' | 'cognito-user-pool';
	/**
	 * Ancillary stores (codes, sessions, tokens, challenges) are usually empty;
	 * they sort last so a populated block does not look broken.
	 */
	ancillary: boolean;
}

/** One record in a store. */
export interface DataRecord {
	/** Display key: key attribute values joined, or the store's serialized key. */
	key: string;
	/** Key attributes by name, so an edit or delete can be addressed properly. */
	keyValues?: Record<string, string>;
	value: unknown;
	/**
	 * The record exactly as stored, present ONLY when `value` was transformed for
	 * display and therefore differs from it.
	 *
	 * The local reader parses a string field that looks like JSON into a real
	 * object one level deep, so a nested structure Blocks persisted as a
	 * serialized string renders as a tree instead of an escaped blob. That is a
	 * display transform, but the record editor seeded its textarea from `value`
	 * and the writer persists what it is given — so saving ANY edit to such a
	 * record silently rewrote that field from a string to an object on disk. The
	 * user changed a title and the field's type changed with it.
	 *
	 * An editor must therefore start from this value when it is present. Set only
	 * on difference, so the common record carries nothing extra.
	 */
	valueAsStored?: unknown;
	/** True when any part of `value` was replaced by the redaction marker. */
	redacted: boolean;
}

/** GET /api/v1/data/[fullId]?stage=&mode=&store=&cursor=&limit= */
export interface DataPageResponse {
	apiVersion: typeof API_VERSION;
	stage: string;
	mode: DataMode;
	blockFullId: string;
	dataSource: 'bb-data' | 'dynamodb' | 'cognito' | 'unavailable';
	dataError?: string;
	dataErrorCode?: AwsErrorCode | 'BLOCK_NOT_FOUND' | 'STORE_NOT_FOUND' | 'ACCESS_DENIED' | 'UNPARSEABLE';
	awsContext?: DeploymentDetailResponse['awsContext'];
	stores: DataStore[];
	activeStore?: string;
	/** Key attribute names in key order, read from DescribeTable for cloud stores. */
	keyFields: string[];
	records: DataRecord[];
	/** Opaque continuation token; absent when the page is the last one. */
	nextCursor?: string;
	/**
	 * Record count. `totalRecordsExact` says whether it is the store's true size
	 * (local files, small tables) or only what has been seen so far — a DynamoDB
	 * scan cannot know the total without paying for a full scan.
	 */
	totalRecords: number;
	totalRecordsExact: boolean;
	/** True when any record on the page was redacted. */
	redacted: boolean;
}

/** Whether a write creates a new record or replaces an existing one. */
export type WriteMode = 'create' | 'edit';

/** POST /api/v1/data/[fullId]/records — body. */
export interface RecordWriteRequest {
	stage: string;
	mode: DataMode;
	store?: string;
	writeMode: WriteMode;
	item: Record<string, unknown>;
}

/** DELETE /api/v1/data/[fullId]/records — body. */
export interface RecordDeleteRequest {
	stage: string;
	mode: DataMode;
	store?: string;
	/** Key attributes by name; taken from DataRecord.keyValues. */
	keyValues: Record<string, string>;
}

/** Response to any record write or delete. */
export interface WriteResponse {
	apiVersion: typeof API_VERSION;
	ok: boolean;
	message: string;
	/**
	 * Set when the write was refused for a reason the user can act on, rather
	 * than failing. Every code here is guidance with a remedy:
	 *
	 * - `LOCAL_SERVER_RUNNING` — the dev server caches the store in memory and
	 *   would clobber the edit, so stop it and retry.
	 * - `ALREADY_EXISTS` / `NOT_FOUND` — the write mode is the wrong one for
	 *   this key; switch to edit, or to create.
	 * - `STORE_NOT_FOUND` / `UNSUPPORTED_STORE` — deliberately NOT folded into
	 *   `NOT_FOUND`. A missing *store* and a missing *record* have opposite
	 *   remedies: one offers "create it", the other means there is nothing to
	 *   create it in. `UNSUPPORTED_STORE` (a store shape with no key model, so
	 *   no record can be addressed) has no neighbour at all.
	 * - `VALIDATION_FAILED` — the record itself is not writable as sent.
	 *
	 * `LOCKED` is deliberately absent. The unlock gate is a property of the
	 * session rather than an outcome of this record, so a locked cloud write is
	 * answered with HTTP 403 and an `ApiError` whose code is `LOCKED` — which
	 * also means a client that inspects only the status cannot mistake a refused
	 * write for an applied one. Listing it here as well would advertise a value
	 * the server never sends.
	 */
	refusalCode?:
		| 'LOCAL_SERVER_RUNNING'
		| 'ALREADY_EXISTS'
		| 'NOT_FOUND'
		| 'STORE_NOT_FOUND'
		| 'UNSUPPORTED_STORE'
		| 'VALIDATION_FAILED';
	/**
	 * Set when the write failed for an environmental reason rather than being
	 * refused on its merits — credentials, permissions, a missing table.
	 *
	 * Separate from `refusalCode` because the two call for different responses: a
	 * refusal means change the request, an error means fix the environment. This
	 * field exists because the cloud writer classified its failures and the
	 * provider then threw the classification away for want of somewhere to put it,
	 * so `ACCESS_DENIED`, `CREDENTIALS_EXPIRED` and a dropped table all reached
	 * the browser as an indistinguishable `{ ok: false, message }` — while the
	 * identical causes on the LOCAL path arrived properly coded. The client even
	 * had specific wording for a missing store that cloud mode could never reach.
	 */
	errorCode?: AwsErrorCode | 'ACCESS_DENIED' | 'STORE_NOT_FOUND';
}

/**
 * GET /api/v1/writes/unlock and POST /api/v1/writes/unlock.
 *
 * Cloud writes are locked by default and the lock is server-side, so a locked
 * write is refused with 403 rather than merely hidden in the UI. The window is
 * absolute from the moment of unlock, not idle-extended.
 */
export interface UnlockResponse {
	apiVersion: typeof API_VERSION;
	unlocked: boolean;
	/** Full window length, so the UI can render a countdown without hardcoding it. */
	ttlMs: number;
	/** ISO timestamp the unlock lapses; absent while locked. */
	expiresAt?: string;
	expiresInMs?: number;
	/** What the unlock covers. Local writes are token-gated but not unlock-gated. */
	scope: 'cloud-writes';
}

/** An ApiNamespace and its callable methods. */
export interface RpcNamespace {
	/** Namespace id as addressed over JSON-RPC, i.e. the block's `id`. */
	namespace: string;
	/**
	 * The block that declares this namespace, when source discovery found one.
	 *
	 * Optional because a namespace can be real, callable and yet have no block to
	 * attribute it to. `auth.createApi()` returns a namespace from a factory
	 * method rather than a `new ApiNamespace(...)` construction, so a source scan
	 * cannot see it while the generated OpenRPC spec — which introspects the
	 * running backend — can. Requiring this field would mean dropping such a
	 * namespace from the playground, and a namespace that answers real calls must
	 * not be invisible.
	 */
	blockFullId?: string;
	methods: ApiMethod[];
}

/** GET /api/v1/rpc/methods */
export interface RpcMethodsResponse {
	apiVersion: typeof API_VERSION;
	/**
	 * 'spec' means parameter types came from the generated blocks spec and a
	 * typed form can be rendered; 'source-scan' means names only.
	 */
	methodsSource: 'spec' | 'source-scan' | 'unavailable';
	methodsError?: string;
	namespaces: RpcNamespace[];
}

/** POST /api/v1/rpc — body. */
export interface RpcInvokeRequest {
	stage: string;
	mode: DataMode;
	/** `namespace.methodName`. */
	method: string;
	/** Positional parameters, matching the JSON-RPC wire format. */
	params: unknown[];
}

/**
 * POST /api/v1/rpc — response.
 *
 * Always HTTP 200 when the call was attempted: the upstream status lives in
 * `httpStatus` so a 401 from the app's own auth is a result to inspect, not a
 * dashboard failure. `ok` reflects transport success only — a JSON-RPC error
 * body arrives with httpStatus 200, which is why `rpcError` is separate.
 */
export interface RpcInvokeResponse {
	apiVersion: typeof API_VERSION;
	stage: string;
	mode: DataMode;
	/** Endpoint actually called, so the user can see which environment answered. */
	endpoint: string;
	ok: boolean;
	httpStatus: number;
	durationMs: number;
	body: unknown;
	/** JSON-RPC level error extracted from `body`, when the payload carries one. */
	rpcError?: { code?: number; message: string; name?: string };
	transportErrorCode?: 'UNREACHABLE' | 'TIMEOUT' | 'NO_ENDPOINT' | 'BAD_METHOD';
}

/** One probe in the doctor report. */
export interface DoctorCheck {
	id: string;
	label: string;
	status: 'ok' | 'warn' | 'fail' | 'skipped';
	detail: string;
	/** Concrete next action when the status is not ok. */
	remediation?: string;
}

/**
 * GET /api/v1/doctor — reports what was detected and changes nothing.
 *
 * Separates "no credentials" from "nothing deployed": both leave cloud mode
 * unavailable, but only one of them is something the user should fix.
 */
export interface DoctorResponse {
	apiVersion: typeof API_VERSION;
	projectRoot: string;
	projectName: string;
	/** How the project directory was resolved. */
	projectVia: 'explicit' | 'cwd' | 'ancestor';
	checks: DoctorCheck[];
	awsContext?: DeploymentDetailResponse['awsContext'];
}

/**
 * How the user said their input should be read.
 *
 * On the wire because the write route takes it: inferring it from the text is
 * what turns the typed `5` into the number 5 behind the user's back.
 */
export type SettingValueKind = 'text' | 'json';

/** Whether a stored value was written by the current encoding or predates it. */
export type SettingEncoding = 'json' | 'raw';

/**
 * Whether the stage holds this setting.
 *
 * `unknown` is a third state on purpose. A deployed template can carry a secret
 * parameter whose name is a CloudFormation intrinsic rather than a literal, and
 * in that case "not in the list of names we could read" does not mean "not
 * deployed". Reporting `absent` there would invite a deploy that is not needed,
 * or worse, a create over a parameter that already exists.
 */
export type SettingPresence = 'present' | 'absent' | 'unknown';

/** Why a setting's stored value is not on screen. */
export type SettingValueHidden =
	/** Declared `secret: true`: never read with decryption on a list path. */
	| 'secret'
	/** The stage does not hold it, or we cannot say that it does. */
	| 'not-present'
	/** No address could be resolved, so there was nothing to read. */
	| 'unaddressable'
	/** The read itself failed; `error` carries why. */
	| 'unreadable';

/** The stored value of one setting, as a reader is allowed to see it. */
export interface SettingValueView {
	/** Text to show. For a masked value this is the mask, never the value. */
	display: string;
	/**
	 * True when `display` is a mask rather than the stored value.
	 *
	 * Computed from what the read actually did, never asserted by a caller:
	 * the reference implementation this package models hardcoded a
	 * `redacted: false` beside a path that applied no redaction, so the flag
	 * the UI trusted was a claim rather than a fact.
	 */
	masked: boolean;
	/** `raw` means the stored value predates the current JSON encoding. */
	encoding?: SettingEncoding;
	/** SSM parameter version, which is what a rollback targets. */
	version?: number;
	/** ISO timestamp of the last write, when the stage reports one. */
	lastModified?: string;
}

/** One declared setting, joined against one stage. */
export interface SettingEntry {
	fullId: string;
	id: string;
	file: string;
	line: number;
	/** SSM path in a deployed stage, settings.json key locally. */
	address?: string;
	presence: SettingPresence;
	secret: boolean;
	/** The app validates writes against a schema that a dashboard write cannot run. */
	hasSchema: boolean;
	external: boolean;
	nameSource: SettingNameSource;
	value?: SettingValueView;
	/** Set when no value is shown, so a blank field is never ambiguous. */
	valueHidden?: SettingValueHidden;
	/** Why this one setting could not be read, when it could not. */
	error?: string;
}

/**
 * One deploy-owned value, shown read-only.
 *
 * These are not editable here and the UI says so: `blocks-config.json` is
 * written into S3 at synth time and the handler's environment variables are set
 * by the template, so a write to either is reverted by the next deploy.
 */
export interface DeployOwnedValue {
	key: string;
	/** Absent when the template carries an intrinsic rather than a literal. */
	value?: string;
	/** True when the value resolves only at deploy time. */
	deployTime: boolean;
}

/** GET /api/v1/settings — declared settings joined against one stage. */
export interface SettingsResponse {
	apiVersion: typeof API_VERSION;
	stage: string;
	mode: DataMode;
	settings: SettingEntry[];
	/**
	 * Live addresses no ADDRESSABLE declaration claims.
	 *
	 * Best effort in both directions, so a consumer must never present it as a
	 * list that is safe to delete. When any entry has no `address`, one of these
	 * may be its parameter; and discovery of them comes from the deployed
	 * template, which does not name a parameter it creates through an intrinsic,
	 * nor one owned outside the stack.
	 */
	orphans: string[];
	/** Handler environment variables the last deploy set. Cloud mode only. */
	environment?: DeployOwnedValue[];
	settingsError?: string;
	settingsErrorCode?: 'NO_CREDENTIALS' | 'NOT_DEPLOYED' | 'ACCESS_DENIED' | 'UNKNOWN';
}

/** POST /api/v1/settings/reveal — one secret, decrypted, on explicit request. */
export interface SettingRevealResponse {
	apiVersion: typeof API_VERSION;
	fullId: string;
	/** The stored value, decoded the way the app's own `get()` decodes it. */
	display: string;
	encoding: SettingEncoding;
	version?: number;
	lastModified?: string;
}

/** One past version of a parameter, for a rollback that is not a guess. */
export interface SettingVersion {
	version: number;
	lastModified?: string;
	/** Who or what wrote it, when the stage reports it. */
	modifiedBy?: string;
	/**
	 * The stored value, decoded. ABSENT for a secret: parameter history
	 * carries the ciphertext, which is neither showable nor useful, and a
	 * decrypted history would hand over every past secret at once.
	 */
	display?: string;
}

/** GET /api/v1/settings/history — versions of one parameter, newest first. */
export interface SettingHistoryResponse {
	apiVersion: typeof API_VERSION;
	fullId: string;
	secret: boolean;
	versions: SettingVersion[];
}

/** Why one setting write was refused. */
export type SettingWriteRefusal =
	/** No declaration carries that `fullId`. */
	| 'not-declared'
	/** Declared, but no parameter path could be resolved from source. */
	| 'unaddressable'
	/** The input is not the JSON the caller said it was. */
	| 'invalid-json'
	/** Over the SSM standard-tier limit, measured on the encoded bytes. */
	| 'too-large'
	/** An empty secret breaks the app at its next read. */
	| 'empty-secret'
	/** The stored version moved since the caller read it. */
	| 'version-conflict'
	/** The stage could not be reached or refused the call. */
	| 'unreachable';

/** PUT /api/v1/settings — one setting written, or refused with a reason. */
export interface SettingWriteResponse {
	apiVersion: typeof API_VERSION;
	fullId: string;
	stage: string;
	mode: DataMode;
	ok: boolean;
	/**
	 * Set when `ok` is false.
	 *
	 * Named `refusalCode` to match the record-write contract, so a client reads
	 * ONE field whether the refusal came from this route's own logic or from a
	 * gate that answered with an `ApiError` (a locked window, an unconfirmed
	 * production write). See `ObservedSettingWriteResponse` for that widening.
	 */
	refusalCode?: SettingWriteRefusal;
	/** Always present: either the confirmation or the reason it was refused. */
	message: string;
	/** What is now stored, masked for a secret. Absent on a refusal. */
	stored?: SettingValueView;
	/**
	 * True when the app validates this setting against a schema that this write
	 * did NOT run, so the stored value may be one the app will reject at read
	 * time. Stated rather than silently implied, for the same reason a direct
	 * record write says it bypasses the app's own validation.
	 */
	schemaUnchecked: boolean;
}
