// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
	DataMode,
	DeploymentRecord,
	DiscoveredBlock,
	EnvironmentInfo,
	LogSearchParams,
	SettingWriteRefusal,
	StageInfo,
} from '../contract/v1.js';
import { resolveAmbientRegion, resolveCliRegion, resolveEnvRegion, resolveProfile } from './aws-config.js';
import { readLocalData } from './bb-data.js';
import { discoverBlocks } from './block-discovery.js';
import {
	classifyEventsError,
	fetchStackEvents,
	filterFailureEvents,
	pickRootCause,
	type RawStackEvent,
	reconstructDeployments,
} from './cfn-events.js';
import { readCloudData } from './cloud-data.js';
import { type MetricTarget, discoverMetricTargets } from './metric-targets.js';
import {
	buildMetricQueries,
	estimateCost,
	fetchMetricData,
	mapMetricData,
	periodForRange,
	summarise,
	classifyUsageError,
	toUsageEstimate,
	toUsageTargets,
} from './metric-usage.js';
import { deleteCloudRecord, putCloudRecord } from './cloud-writes.js';
import {
	buildCostQuery,
	evaluateTagActivation,
	fetchCostAllocationTags,
	fetchCostAndUsage,
	mapCostResults,
	type RawCostAllocationTag,
} from './cost.js';
import type {
	BlocksResult,
	CostResult,
	DataPageParams,
	DataPageResult,
	DataProvider,
	DeploymentDetail,
	DoctorResult,
	EnvironmentsResult,
	LogGroupsResult,
	LogSearchResult,
	ProjectMeta,
	RecordDeleteParams,
	RecordWriteParams,
	ResourcesResult,
	RpcInvokeParams,
	RpcInvokeResult,
	RpcMethodsResult,
	SettingHistoryResult,
	SettingRevealResult,
	SettingsParams,
	SettingsResult,
	SettingTargetParams,
	SettingWriteParams,
	SettingWriteResult,
	UsageParams,
	UsageResult,
	WriteResult,
} from './data-provider.js';
import { runDoctor } from './doctor.js';
import {
	fetchStackDescription,
	isStackNotFound,
	type RawStackDescription,
	selectInterestingOutputs,
	stackConsoleUrl,
} from './environments.js';
import { deleteLocalRecord, putLocalRecord } from './local-writes.js';
import {
	fetchLogGroupMetadata,
	fetchStackResources,
	type RawStackResource,
	resourcesToLogGroups,
} from './log-groups.js';
import {
	buildInsightsQuery,
	type InsightsQueryResult,
	type InsightsRunnerOptions,
	InsightsTimeoutError,
	rowsToLogEntries,
	runInsightsQuery,
} from './log-search.js';
import {
	fetchStackTemplate,
	groupResources,
	type RawTemplate,
	resolveAppScope,
	templateCdkPaths,
} from './resources.js';
import { resolveRpcEndpoint } from './rpc-endpoint.js';
import { invokeRpc } from './rpc-invoke.js';
import { buildRpcMethodCatalogue } from './rpc-methods.js';
import {
	cloudAddressFor,
	declaredSettings,
	decodeSettingValue,
	encodeSettingValue,
	joinSettings,
	templateHandlerEnvironment,
	templateParameterNames,
} from './settings-inventory.js';
import {
	classifyReadError,
	fetchDecryptedParameter,
	fetchParameterHistory,
	fetchParameterValues,
	putParameter,
	readLocalSettings,
	writeLocalSetting,
} from './settings-store.js';
import { buildLocalSettingEntry, buildSettingEntry, storedView } from './settings-view.js';
import { type RegionSource, resolveStageRegion, type StageOutputsStatus, WRITER_COMMAND } from './stage-outputs.js';

const BACKFILL_CACHE_TTL_MS = 60_000;

/**
 * The page shape both data readers return, derived from the readers themselves
 * rather than restated here — a change in either module surfaces as a type
 * error at the mapping site instead of drifting silently.
 */
type DataPage = ReturnType<typeof readLocalData> | Awaited<ReturnType<typeof readCloudData>>;

/**
 * Write contexts and results, derived from the writers rather than restated
 * here — same reasoning as {@link DataPage}. A change in either write module
 * surfaces as a type error at the call site instead of drifting silently.
 *
 * Put and delete share one context per mode, so the guard in
 * `resolveWriteTarget` cannot be satisfied for one operation and skipped for
 * the other.
 */
type LocalWriteContext = Parameters<typeof putLocalRecord>[0];
type CloudWriteContext = Parameters<typeof putCloudRecord>[0];
type WriterResult = Awaited<ReturnType<typeof putLocalRecord>> | Awaited<ReturnType<typeof putCloudRecord>>;

/** A resolved write destination, or the refusal that replaces it. */
type WriteTarget =
	| { kind: 'refused'; result: WriteResult }
	| { kind: 'local'; context: LocalWriteContext }
	| { kind: 'cloud'; context: CloudWriteContext };

/**
 * Reader error code → contract error code.
 *
 * The readers' union is currently WIDER than the contract's: both can report
 * `BAD_CURSOR`, which `DataPageResponse['dataErrorCode']` does not list (that
 * type lives in `src/contract/v1.ts`, which this task does not own). The value
 * is forwarded verbatim rather than folded into a neighbouring code —
 * relabelling a caller's bad cursor as `UNPARSEABLE` would blame the store for
 * a malformed request, and blame in an error code is what a reader acts on.
 * Delete the cast once the contract union includes `BAD_CURSOR`.
 */
function toContractErrorCode(errorCode: NonNullable<DataPage['errorCode']>): DataPageResult['dataErrorCode'] {
	return errorCode as DataPageResult['dataErrorCode'];
}

/**
 * A stack-describe failure in OUR words, keyed off the existing classifier.
 *
 * Never the SDK's message. An AccessDenied from `DescribeStacks` reads
 * "User: arn:aws:sts::<account>:assumed-role/… is not authorized to perform …",
 * so echoing it puts an account id and a role ARN in the response body. Every
 * other pillar already substitutes its own text for this reason; `EnvironmentInfo`
 * carries only an `error` string and no code field, which is how the raw message
 * kept reaching a client here.
 */
function describeStackFailure(error: unknown): string {
	switch (classifyEventsError(error)) {
		case 'CREDENTIALS_EXPIRED':
			return 'Could not describe the stack: the AWS credentials have expired. Refresh them and reload — credentials are re-read per request, so no restart is needed.';
		case 'CREDENTIALS_MISSING':
			return 'Could not describe the stack: no AWS credentials were available to this process.';
		case 'STACK_NOT_FOUND':
			return 'Could not describe the stack: CloudFormation reports no stack by that name in this region.';
		default:
			return 'Could not describe the stack: CloudFormation refused the request. Check that this profile is allowed to call DescribeStacks in this region.';
	}
}

/**
 * Block discovery is a source-file AST scan, so re-parsing the project on every
 * request is wasteful — but source changes while the dashboard is open, and a
 * stale block list after an edit is worse than a re-parse. Hence a deliberately
 * short TTL: cheap enough to absorb a polling UI, short enough that a save is
 * reflected on the next look.
 */
const BLOCKS_CACHE_TTL_MS = 60_000;

const STAGES = ['sandbox', 'production'] as const;

/** Two-minute tolerance: history timestamps and CFN event times differ slightly. */
const OVERLAP_TOLERANCE_MS = 2 * 60_000;

/** Fallback window for records with no finishedAt (in-progress / died). */
const OPEN_RECORD_WINDOW_MS = 60 * 60_000;

/**
 * Human phrase for a region tier, for a sentence a developer can act on: the
 * remedy for "from your --region flag" is different from the remedy for "from
 * the sandbox deploy's own outputs file".
 */
function regionSourceLabel(source: RegionSource): string {
	switch (source) {
		case 'cli':
			return 'your --region flag';
		case 'env':
			return 'AWS_REGION in the environment';
		case 'outputs':
			return "that stage's own CDK outputs file";
		case 'none':
			return 'no stated source';
	}
}

function overlaps(a: DeploymentRecord, b: DeploymentRecord): boolean {
	if (a.stage !== b.stage) return false;
	const aStart = Date.parse(a.startedAt) - OVERLAP_TOLERANCE_MS;
	const aEnd =
		(a.finishedAt ? Date.parse(a.finishedAt) : Date.parse(a.startedAt) + OPEN_RECORD_WINDOW_MS) +
		OVERLAP_TOLERANCE_MS;
	const bStart = Date.parse(b.startedAt);
	const bEnd = b.finishedAt ? Date.parse(b.finishedAt) : Date.parse(b.startedAt) + OPEN_RECORD_WINDOW_MS;
	return bStart <= aEnd && bEnd >= aStart;
}

/**
 * DataProvider for the local `blocks dashboard` server.
 *
 * Reads project state from the app directory (.blocks/, package.json) and —
 * in later milestones — AWS APIs using the developer's local credentials.
 * Deploy history primary source is .blocks/deploy-history.jsonl (written by
 * deploy.ts from M1 on); CloudFormation events are only a backfill.
 */
export class LocalDataProvider implements DataProvider {
	constructor(
		private readonly projectRoot: string,
		/** Test seam: CFN event fetch, defaults to the real SDK call. */
		private readonly fetchEvents: (
			stackName: string,
			region?: string,
		) => Promise<RawStackEvent[]> = fetchStackEvents,
		/** Test seam: CFN stack resource listing. */
		private readonly fetchResources: (
			stackName: string,
			region?: string,
		) => Promise<RawStackResource[]> = fetchStackResources,
		/** Test seam: CloudWatch Logs metadata enrichment. */
		private readonly fetchLogMetadata: typeof fetchLogGroupMetadata = fetchLogGroupMetadata,
		/** Test seam: Logs Insights query execution. */
		private readonly runInsights: (
			options: InsightsRunnerOptions,
		) => Promise<InsightsQueryResult> = runInsightsQuery,
		/** Test seam: stack template fetch (cdk paths for resource grouping). */
		private readonly fetchTemplate: (
			stackName: string,
			region?: string,
		) => Promise<RawTemplate> = fetchStackTemplate,
		/** Test seam: stack description fetch (environments view). */
		private readonly fetchDescription: (
			stackName: string,
			region?: string,
		) => Promise<RawStackDescription> = fetchStackDescription,
		/** Test seam: cost allocation tag listing. */
		private readonly fetchCostTags: () => Promise<RawCostAllocationTag[]> = fetchCostAllocationTags,
		/** Test seam: GetCostAndUsage execution. */
		private readonly fetchCosts: typeof fetchCostAndUsage = fetchCostAndUsage,
		/** Test seam: the doctor run (probes the local + AWS environment). */
		private readonly runDoctorImpl: typeof runDoctor = runDoctor,
		/** Test seam: source-scan block discovery (never throws by contract). */
		private readonly discoverBlocksImpl: typeof discoverBlocks = discoverBlocks,
		/** Test seam: local .blocks-data store read (never throws by contract). */
		private readonly readLocalDataImpl: typeof readLocalData = readLocalData,
		/** Test seam: deployed-store read (never rejects by contract). */
		private readonly readCloudDataImpl: typeof readCloudData = readCloudData,
		/**
		 * Write seams, appended in this order and never reordered: every existing
		 * positional argument above keeps its index, so no current caller or test
		 * changes meaning by this addition.
		 */
		private readonly putLocalRecordImpl: typeof putLocalRecord = putLocalRecord,
		/** Test seam: local .bb-data record delete. */
		private readonly deleteLocalRecordImpl: typeof deleteLocalRecord = deleteLocalRecord,
		/** Test seam: deployed-store record put. */
		private readonly putCloudRecordImpl: typeof putCloudRecord = putCloudRecord,
		/** Test seam: deployed-store record delete. */
		private readonly deleteCloudRecordImpl: typeof deleteCloudRecord = deleteCloudRecord,
		/**
		 * RPC seams (M7), appended after the write seams and never reordered, for
		 * the same reason the write seams were appended after the read seams:
		 * every existing positional argument keeps its index, so no current caller
		 * or test changes meaning by this addition.
		 */
		private readonly buildRpcMethodCatalogueImpl: typeof buildRpcMethodCatalogue = buildRpcMethodCatalogue,
		/** Test seam: endpoint resolution (returns a NO_ENDPOINT result, never throws). */
		private readonly resolveRpcEndpointImpl: typeof resolveRpcEndpoint = resolveRpcEndpoint,
		/** Test seam: the RPC call itself (reports transport failure inside its result). */
		private readonly invokeRpcImpl: typeof invokeRpc = invokeRpc,
		/**
		 * Usage seam (M8), appended last for the same reason every earlier group
		 * was: positional indices above are unchanged, so no existing caller or
		 * test changes meaning.
		 *
		 * This is the ONLY billable call in the usage path, which is what makes
		 * the consent gate testable: a test can count invocations of this seam and
		 * assert it is zero for an unconfirmed request.
		 */
		private readonly fetchMetricDataImpl: typeof fetchMetricData = fetchMetricData,
		/**
		 * Settings seams (M9), appended last for the same reason every earlier
		 * group was: positional indices above are unchanged, so no existing
		 * caller or test changes meaning.
		 *
		 * `fetchParameterValuesImpl` is the ONLY seam the listing uses, and it
		 * never decrypts. A test can therefore assert that listing a stage full
		 * of secrets makes no decrypted call at all, because the seam that could
		 * make one is a different function.
		 */
		private readonly fetchParameterValuesImpl: typeof fetchParameterValues = fetchParameterValues,
		/** Test seam: the one decrypted read, for a reveal asked for by name. */
		private readonly fetchDecryptedParameterImpl: typeof fetchDecryptedParameter = fetchDecryptedParameter,
		/** Test seam: parameter version history (never decrypted). */
		private readonly fetchParameterHistoryImpl: typeof fetchParameterHistory = fetchParameterHistory,
		/** Test seam: the mock's settings file (never throws by contract). */
		private readonly readLocalSettingsImpl: typeof readLocalSettings = readLocalSettings,
		/** Test seam: the one SSM write. Counted in tests, like the metric fetch. */
		private readonly putParameterImpl: typeof putParameter = putParameter,
		/** Test seam: the mock settings file write. */
		private readonly writeLocalSettingImpl: typeof writeLocalSetting = writeLocalSetting,
	) {}

	/**
	 * The AWS identity/region context to report alongside a result.
	 *
	 * Resolved through aws-config, which is also what the SDK clients use. These
	 * sites previously read `process.env.AWS_PROFILE` and `process.env.AWS_REGION`
	 * directly, so a `--profile` flag was invisible here (the dashboard could
	 * name a profile that was NOT the one credentials came from) and
	 * `AWS_DEFAULT_REGION` was ignored even though the AWS CLI honours it.
	 *
	 * `regionSource` names the tier the region came from rather than merely
	 * whether one was recorded, because the tiers now disagree in ways a developer
	 * has to be able to see: `cli` means their `--region` is in force, `outputs`
	 * means it came from that stage's own CDK outputs document, and `none` means
	 * no tier supplied one — so any "nothing found" that follows is about a region
	 * the SDK chose, not one we verified.
	 *
	 * @param region - Region resolved for this stage, if any.
	 * @param source - Which tier supplied it. Defaults to the stage-free tiers.
	 */
	private awsContextFor(
		region?: string,
		source?: RegionSource,
	): {
		profile?: string;
		region?: string;
		regionSource: RegionSource;
	} {
		const profile = resolveProfile();
		if (source) {
			return {
				...(profile ? { profile } : {}),
				...(region ? { region } : {}),
				regionSource: source,
			};
		}
		// Stage-free call: only the flag and the environment can apply.
		const cli = resolveCliRegion();
		const ambient = region ?? resolveAmbientRegion();
		return {
			...(profile ? { profile } : {}),
			...(ambient ? { region: ambient } : {}),
			regionSource: ambient ? (cli && ambient === cli ? 'cli' : 'env') : 'none',
		};
	}

	async getProjectMeta(): Promise<ProjectMeta> {
		return {
			projectName: this.readProjectName(),
			projectRoot: this.projectRoot,
			stages: this.readStages(),
		};
	}

	private backfillCache: { at: number; records: DeploymentRecord[] } | undefined;

	async listDeployments(stage?: string): Promise<DeploymentRecord[]> {
		const history = this.readDeployHistory();
		const backfill = await this.getBackfill();
		// History is primary: drop reconstructed episodes that overlap a
		// history record of the same stage (they describe the same deploy).
		const merged = [
			...history,
			...backfill.filter((episode) => !history.some((record) => overlaps(record, episode))),
		].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
		return stage ? merged.filter((r) => r.stage === stage) : merged;
	}

	/**
	 * BACKFILL: deployment episodes reconstructed from CFN stack events, for
	 * deploys made before deploy-history.jsonl existed. Best-effort — any
	 * failure (no credentials, no stack) silently yields no backfill, the
	 * primary history still renders. Cached briefly; the list view polls.
	 */
	private async getBackfill(): Promise<DeploymentRecord[]> {
		if (this.backfillCache && Date.now() - this.backfillCache.at < BACKFILL_CACHE_TTL_MS) {
			return this.backfillCache.records;
		}
		const records: DeploymentRecord[] = [];
		for (const stage of STAGES) {
			const stackName = this.resolveStackName(stage);
			if (!stackName) continue;
			try {
				const events = await this.fetchEvents(stackName);
				records.push(...reconstructDeployments(events, stackName, stage));
			} catch {
				// No credentials, stack deleted, or API error — skip this stage.
			}
		}
		this.backfillCache = { at: Date.now(), records };
		return records;
	}

	async getDeployment(id: string): Promise<DeploymentDetail | undefined> {
		const deployment =
			this.readDeployHistory().find((r) => r.id === id) ?? (await this.getBackfill()).find((r) => r.id === id);
		if (!deployment) return undefined;

		// Events only matter for failure analysis: FAILED, ROLLED_BACK (how
		// CFN reports a failed-then-reverted update), and IN_PROGRESS (live
		// deploys or died-mid-deploy) are all worth inspecting.
		if (deployment.status === 'SUCCEEDED' || deployment.status === 'UNKNOWN') {
			return { deployment, eventsSource: 'not-applicable', failureEvents: [] };
		}

		// The stack name recorded at deploy time still wins: the deploy knew
		// exactly which stack it targeted, and that field has no competing source.
		// The recorded REGION is deliberately not used — see resolveStackTarget.
		// A record from a region the stage no longer resolves to will report that
		// its events were not found in the region we looked in, which is the
		// honest outcome while the dashboard shows one deployment per stage.
		const target = this.resolveStackTarget(deployment.stage);
		const stackName = deployment.stackName ?? target.stackName;
		const region = target.region;
		const awsContext = this.awsContextFor(region, target.regionSource);

		if (!stackName) {
			return {
				deployment,
				eventsSource: 'unavailable',
				eventsError: `Could not resolve the CloudFormation stack name for stage "${deployment.stage}".`,
				eventsErrorCode: 'UNKNOWN',
				awsContext,
				failureEvents: [],
			};
		}

		try {
			const raw = await this.fetchEvents(stackName, region);
			const failureEvents = filterFailureEvents(raw, { from: deployment.startedAt, to: deployment.finishedAt });
			return {
				deployment,
				stackName,
				eventsSource: 'cloudformation',
				awsContext,
				failureEvents,
				rootCause: pickRootCause(failureEvents),
			};
		} catch (error) {
			return {
				deployment,
				stackName,
				eventsSource: 'unavailable',
				eventsError: `Could not fetch stack events: ${error instanceof Error ? error.message : String(error)}`,
				eventsErrorCode: classifyEventsError(error),
				awsContext,
				failureEvents: [],
			};
		}
	}

	/**
	 * Stack target for a stage: which stack, in which region, and on whose word.
	 *
	 * **Both answers now come from the stage's own CDK outputs document**
	 * ({@link resolveStageRegion}) rather than from the deploy record. The record
	 * carried a `region` re-derived at deploy time through a resolver that can
	 * disagree with the region CDK deployed to; once written, a wrong region is
	 * indistinguishable from a right one, and querying it produced a
	 * CloudFormation "does not exist" that the environments view rendered as
	 * "not deployed" about a standing stack.
	 *
	 * Stack name precedence is outputs document, then the deploy record, then the
	 * name derived from `.blocks/config.json` + `sandbox-id.txt`. The derived name
	 * is last because it is re-derived from two local files and goes stale: the
	 * sandbox id is per-machine and gitignored, so losing it mints a new one and
	 * the derived name starts naming a stack that does not exist.
	 */
	private resolveStackTarget(stage: string): {
		stackName?: string;
		region?: string;
		regionSource: RegionSource;
		/** Why no region resolved, or why the outputs document was unusable. */
		reason?: string;
		outputsStatus?: StageOutputsStatus;
	} {
		if (stage !== 'sandbox' && stage !== 'production') {
			// No outputs document exists for a stage Blocks cannot deploy; keep the
			// derived name so callers still report a resolvable target.
			return { stackName: this.resolveStackName(stage), regionSource: 'none' };
		}

		const resolved = resolveStageRegion(this.projectRoot, stage, {
			...(resolveCliRegion() ? { cli: resolveCliRegion() } : {}),
			...(resolveEnvRegion() ? { env: resolveEnvRegion() } : {}),
		});
		const recorded = this.readDeployHistory().find((r) => r.stage === stage && r.stackName);
		const stackName = resolved.outputs.stackName ?? recorded?.stackName ?? this.resolveStackName(stage);

		return {
			...(stackName ? { stackName } : {}),
			...(resolved.region ? { region: resolved.region } : {}),
			regionSource: resolved.source,
			...(resolved.reason ? { reason: resolved.reason } : {}),
			outputsStatus: resolved.outputs.status,
		};
	}

	async listLogGroups(stage: string): Promise<LogGroupsResult> {
		const { stackName, region, regionSource } = this.resolveStackTarget(stage);
		const awsContext = this.awsContextFor(region, regionSource);

		if (!stackName) {
			return {
				stage,
				groupsSource: 'unavailable',
				groupsError: `Could not resolve the CloudFormation stack name for stage "${stage}" — deploy first, or check .blocks/config.json.`,
				groupsErrorCode: 'UNKNOWN',
				awsContext,
				groups: [],
			};
		}

		try {
			const resources = await this.fetchResources(stackName, region);
			const groups = resourcesToLogGroups(resources);
			// Enrichment is best-effort decoration; discovery already succeeded.
			const metadata = await this.fetchLogMetadata(
				groups.map((g) => g.name),
				region,
			);
			for (const group of groups) {
				const meta = metadata.get(group.name);
				if (meta) {
					group.retentionDays = meta.retentionDays;
					if (meta.storedBytes !== undefined) group.storedBytes = meta.storedBytes;
				}
			}
			return { stage, stackName, groupsSource: 'cloudformation', awsContext, groups };
		} catch (error) {
			return {
				stage,
				stackName,
				groupsSource: 'unavailable',
				groupsError: `Could not list stack resources: ${error instanceof Error ? error.message : String(error)}`,
				groupsErrorCode: classifyEventsError(error),
				awsContext,
				groups: [],
			};
		}
	}

	async searchLogs(params: LogSearchParams): Promise<LogSearchResult> {
		const { stage } = params;
		const { region, regionSource } = this.resolveStackTarget(stage);
		const awsContext = this.awsContextFor(region, regionSource);

		// Reuse discovery: the search spans exactly the app's log groups.
		const discovery = await this.listLogGroups(stage);
		if (discovery.groupsSource === 'unavailable') {
			return {
				stage,
				searchSource: 'unavailable',
				searchError: discovery.groupsError,
				searchErrorCode: discovery.groupsErrorCode,
				awsContext,
				queriedGroups: [],
				entries: [],
			};
		}
		// Single-group scoping (click-through from the groups table). The
		// group must come from discovery — arbitrary names are refused.
		if (params.group) {
			const known = discovery.groups.find((g) => g.name === params.group);
			if (!known) {
				return {
					stage,
					searchSource: 'unavailable',
					searchError: `Log group "${params.group}" is not part of the ${stage} stack.`,
					searchErrorCode: 'UNKNOWN',
					awsContext,
					queriedGroups: [],
					entries: [],
				};
			}
		}

		// StartQuery rejects the WHOLE query if any named group doesn't exist,
		// and Lambdas that never logged have no group yet. Enrichment metadata
		// doubles as an existence check (only real groups get metadata); if
		// enrichment failed entirely, fall back to all groups optimistically.
		const confirmedExisting = discovery.groups.filter(
			(g) => g.retentionDays !== undefined || g.storedBytes !== undefined,
		);
		const candidates = confirmedExisting.length > 0 ? confirmedExisting : discovery.groups;
		const queriedGroups = candidates.filter((g) => !params.group || g.name === params.group).map((g) => g.name);
		if (queriedGroups.length === 0) {
			return { stage, searchSource: 'insights', awsContext, queriedGroups, entries: [] };
		}

		try {
			const resolved = buildInsightsQuery(params);
			const result = await this.runInsights({
				logGroupNames: queriedGroups,
				queryString: resolved.queryString,
				startTime: resolved.startTime,
				endTime: resolved.endTime,
				limit: resolved.limit,
				region,
			});
			return {
				stage,
				searchSource: 'insights',
				awsContext,
				queriedGroups,
				entries: rowsToLogEntries(result.rows),
				...(result.scannedBytes !== undefined || result.matchedEvents !== undefined
					? {
							stats: {
								...(result.scannedBytes !== undefined ? { scannedBytes: result.scannedBytes } : {}),
								...(result.matchedEvents !== undefined ? { matchedEvents: result.matchedEvents } : {}),
							},
						}
					: {}),
			};
		} catch (error) {
			return {
				stage,
				searchSource: 'unavailable',
				searchError: `Log search failed: ${error instanceof Error ? error.message : String(error)}`,
				searchErrorCode: error instanceof InsightsTimeoutError ? 'QUERY_TIMEOUT' : classifyEventsError(error),
				awsContext,
				queriedGroups,
				entries: [],
			};
		}
	}

	async listResources(stage: string): Promise<ResourcesResult> {
		const { stackName, region, regionSource } = this.resolveStackTarget(stage);
		const awsContext = this.awsContextFor(region, regionSource);

		if (!stackName) {
			return {
				stage,
				resourcesSource: 'unavailable',
				resourcesError: `Could not resolve the CloudFormation stack name for stage "${stage}".`,
				resourcesErrorCode: 'UNKNOWN',
				awsContext,
				groups: [],
				totalResources: 0,
			};
		}

		try {
			const [resources, template, discovery] = await Promise.all([
				this.fetchResources(stackName, region),
				this.fetchTemplate(stackName, region),
				// Discovery supplies the app scope's NAME and the group labels, so
				// its failure must never fail the resources view — degrade to the
				// template-only scope heuristic and unlabelled groups.
				this.listBlocks().catch(() => undefined),
			]);
			const cdkPaths = templateCdkPaths(template);
			// The region the SDK calls above actually used: recorded at deploy
			// time when known, otherwise ambient. Console links need the real
			// one or none at all.
			const effectiveRegion = region ?? resolveAmbientRegion();
			const groups = groupResources(resources, cdkPaths, {
				appScope: resolveAppScope(cdkPaths, discovery?.scope?.id),
				stackName,
				...(effectiveRegion ? { region: effectiveRegion } : {}),
				blocks: discovery?.blocks ?? [],
			});
			return {
				stage,
				stackName,
				resourcesSource: 'cloudformation',
				awsContext,
				groups,
				totalResources: groups.reduce((sum, g) => sum + g.resources.length, 0),
			};
		} catch (error) {
			return {
				stage,
				stackName,
				resourcesSource: 'unavailable',
				resourcesError: `Could not list resources: ${error instanceof Error ? error.message : String(error)}`,
				resourcesErrorCode: classifyEventsError(error),
				awsContext,
				groups: [],
				totalResources: 0,
			};
		}
	}

	/**
	 * The sandbox and production environments, each discovered on its own terms.
	 *
	 * **Region is resolved per stage, not once per response.** The two stages read
	 * separate CDK outputs documents, so they can legitimately resolve to
	 * different regions at the same moment — a sandbox in eu-west-1 beside a
	 * production stack in us-east-1 is a normal state, and one region for the
	 * whole response could only have been right for one of them. Profile and
	 * account stay response-level, because one dashboard process has one
	 * credential chain.
	 *
	 * **`not-deployed` and `unknown` are kept apart, deliberately.**
	 * `not-deployed` means we looked and nothing was there, or there is nothing
	 * local that could name a deployment at all. `unknown` means we could not
	 * look, or looked somewhere we cannot vouch for. The distinction is the whole
	 * point: the defect this replaces reported "No deployed stack for sandbox yet"
	 * about a `CREATE_COMPLETE` stack, because a lookup in the wrong region
	 * returned "does not exist" and that was read as evidence.
	 */
	async listEnvironments(): Promise<EnvironmentsResult> {
		const awsContext = this.awsContextFor(undefined);

		const environments: EnvironmentInfo[] = await Promise.all(
			STAGES.map(async (stage): Promise<EnvironmentInfo> => {
				const { stackName, region, regionSource, reason, outputsStatus } = this.resolveStackTarget(stage);
				if (!stackName) {
					return {
						stage,
						state: 'not-deployed',
						regionSource,
						stateReason: `No stack name could be resolved for "${stage}" — no ${stage} outputs file, no deploy record, and no .blocks/config.json to derive one from. Run \`${WRITER_COMMAND[stage === 'production' ? 'production' : 'sandbox']}\` first.`,
					};
				}

				const base: EnvironmentInfo = {
					stage,
					stackName,
					...(region ? { region } : {}),
					regionSource,
					state: 'unknown',
				};

				// Tier 4: no --region, no AWS_REGION, and no usable outputs document.
				// There is no region to query and nothing that says where this stage
				// was deployed, so there is no lookup to perform. Reporting the
				// outcome without an AWS call is the honest answer AND the cheap one;
				// guessing a region here is exactly how a standing stack got reported
				// as not deployed.
				if (!region) {
					const state = outputsStatus === 'unusable' ? 'unknown' : 'not-deployed';
					return {
						...base,
						state,
						...(reason
							? {
									stateReason: `${reason} Pass \`--region <region>\` (or set AWS_REGION) to look for "${stackName}" in a specific region.`,
								}
							: {}),
					};
				}

				try {
					const description = await this.fetchDescription(stackName, region);
					return {
						...base,
						state: 'deployed',
						...(description.StackStatus ? { stackStatus: description.StackStatus } : {}),
						...(description.LastUpdatedTime || description.CreationTime
							? { lastUpdated: (description.LastUpdatedTime ?? description.CreationTime)?.toISOString() }
							: {}),
						...(description.DriftInformation?.StackDriftStatus
							? { driftStatus: description.DriftInformation.StackDriftStatus }
							: {}),
						...(description.DriftInformation?.LastCheckTimestamp
							? { driftCheckedAt: description.DriftInformation.LastCheckTimestamp.toISOString() }
							: {}),
						...(selectInterestingOutputs(description)
							? { outputs: selectInterestingOutputs(description) }
							: {}),
						consoleUrl: stackConsoleUrl(stackName, region),
					};
				} catch (error) {
					if (isStackNotFound(error)) {
						// We DID look, and in a region we can name. That makes this the
						// one honest not-deployed: say where we looked, so it reads as
						// "nothing in <region>" rather than "nothing anywhere".
						return {
							...base,
							state: 'not-deployed',
							stateReason: `No stack named "${stackName}" in ${region} (region from ${regionSourceLabel(regionSource)}).`,
						};
					}
					return {
						...base,
						state: 'unknown',
						// Our own wording, not the SDK's. A DescribeStacks denial reads
						// "User: arn:aws:sts::<account>:assumed-role/… is not authorized
						// to perform …", which puts an account id and a role ARN into the
						// payload. Every other pillar substitutes its own text for exactly
						// this reason; this one echoed the raw message through.
						error: describeStackFailure(error),
					};
				}
			}),
		);

		return { awsContext, environments };
	}

	private costCache = new Map<string, { at: number; result: CostResult }>();

	/**
	 * Cost view (M4). Cached 15 minutes per stage: Cost Explorer bills
	 * ~$0.01 per request and its data granularity is daily anyway.
	 */
	async getCost(stage: string): Promise<CostResult> {
		const cached = this.costCache.get(stage);
		if (cached && Date.now() - cached.at < 15 * 60_000) return cached.result;

		const { stackName } = this.resolveStackTarget(stage);
		const profile = resolveProfile();
		const awsContext = {
			...(profile ? { profile } : {}),
			// Cost Explorer is global (us-east-1 endpoint), so no stage region was
			// resolved and none applies — 'none' says that, where 'ambient' used to
			// imply a region had been picked up from somewhere.
			regionSource: 'none' as const,
		};

		let result: CostResult;
		try {
			// Linked accounts in an AWS Organization cannot call
			// ListCostAllocationTags (management-account API) — treat tag
			// activation as unknown and PROBE instead: a filtered query on an
			// inactive tag isn't an error, it just returns zero rows.
			let activation: ReturnType<typeof evaluateTagActivation> | undefined;
			try {
				activation = evaluateTagActivation(await this.fetchCostTags());
			} catch {
				activation = undefined;
			}

			if (activation) {
				const query = buildCostQuery(activation, stage, stackName);
				const mapped = mapCostResults(await this.fetchCosts(query));
				result = {
					stage,
					costSource: 'cost-explorer',
					awsContext,
					attribution: query.attribution,
					...(stackName ? { stackName } : {}),
					...(mapped.currency ? { currency: mapped.currency } : {}),
					days: mapped.days,
					total: mapped.total,
					byService: mapped.byService,
					tags: activation,
					fetchedAt: new Date().toISOString(),
				};
			} else {
				// Probe: stack-tag filter first; empty result falls back to
				// unfiltered account totals. Worst case two CE requests, cached.
				const probeQuery = buildCostQuery(
					{ stackNameTagActive: Boolean(stackName), deploymentTypeTagActive: false },
					stage,
					stackName,
				);
				let mapped = mapCostResults(await this.fetchCosts(probeQuery));
				let attribution = probeQuery.attribution;
				if (mapped.total === 0 && probeQuery.attribution !== 'account-unattributed') {
					const fallback = buildCostQuery(
						{ stackNameTagActive: false, deploymentTypeTagActive: false },
						stage,
						stackName,
					);
					mapped = mapCostResults(await this.fetchCosts(fallback));
					attribution = fallback.attribution;
				}
				result = {
					stage,
					costSource: 'cost-explorer',
					awsContext,
					attribution,
					...(stackName ? { stackName } : {}),
					...(mapped.currency ? { currency: mapped.currency } : {}),
					days: mapped.days,
					total: mapped.total,
					byService: mapped.byService,
					// tags omitted: activation state not determinable from a linked account.
					fetchedAt: new Date().toISOString(),
				};
			}
		} catch (error) {
			const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
			const classified = /AccessDenied|not authorized/i.test(message)
				? ('ACCESS_DENIED' as const)
				: classifyEventsError(error) === 'CREDENTIALS_EXPIRED'
					? ('CREDENTIALS_EXPIRED' as const)
					: classifyEventsError(error) === 'CREDENTIALS_MISSING'
						? ('CREDENTIALS_MISSING' as const)
						: ('UNKNOWN' as const);
			result = {
				stage,
				costSource: 'unavailable',
				costError: `Could not fetch cost data: ${error instanceof Error ? error.message : String(error)}`,
				costErrorCode: classified,
				awsContext,
				...(stackName ? { stackName } : {}),
				days: [],
				byService: [],
			};
		}
		// Cache errors too: a failing CE call repeated by a polling UI would
		// still bill per request.
		this.costCache.set(stage, { at: Date.now(), result });
		return result;
	}

	/**
	 * Usage metrics for one stage, gated on explicit consent.
	 *
	 * THE GUARANTEE: with `confirmed: false` this reaches CloudWatch not at all.
	 * Discovery uses CloudFormation (ListStackResources, GetTemplate), which
	 * carries no per-request charge, so the gated answer is free rather than
	 * merely cheap — and the estimate it returns is computed from the very query
	 * set a confirmed call would send, so the two cannot disagree.
	 *
	 * Deliberately NOT cached, unlike {@link getCost}. A cache would make the
	 * second refresh free and the first expensive, which is exactly the
	 * asymmetry that makes a consent screen lie: the user would authorise a
	 * charge that did not happen, or re-authorise one already paid. The view
	 * refreshes on demand only, so there is no polling to protect against.
	 */
	async getUsage(params: UsageParams): Promise<UsageResult> {
		const { stage, rangeMinutes, confirmed } = params;
		const { stackName, region, regionSource } = this.resolveStackTarget(stage);
		const awsContext = this.awsContextFor(region, regionSource);
		const periodSeconds = periodForRange(rangeMinutes);
		// An empty query set still prices correctly (at nothing), so the
		// not-deployed answer carries the same shape as every other.
		const emptyEstimate = toUsageEstimate(estimateCost([]));

		if (!stackName) {
			return {
				stage,
				usageSource: 'unavailable',
				usageError: `Could not resolve the CloudFormation stack name for stage "${stage}".`,
				usageErrorCode: 'UNKNOWN',
				awsContext,
				rangeMinutes,
				periodSeconds,
				estimate: emptyEstimate,
				targets: [],
			};
		}

		// The region every non-CloudFront target is read from. Resolved BEFORE
		// discovery, because without one there is nothing honest to query: an
		// absent region makes `awsClientConfig` fall back to the ambient one,
		// which would read some other region's metrics and label them this
		// stage's. That is the exact misattribution the per-stage region
		// resolution exists to prevent, so it is refused rather than guessed.
		const effectiveRegion = region ?? resolveAmbientRegion();
		if (!effectiveRegion) {
			return {
				stage,
				stackName,
				usageSource: 'unavailable',
				usageError: `No region resolved for stage "${stage}", so there is no region to read metrics from. Pass --region, or set AWS_REGION.`,
				usageErrorCode: 'UNKNOWN',
				awsContext,
				rangeMinutes,
				periodSeconds,
				estimate: emptyEstimate,
				targets: [],
			};
		}

		let targets: MetricTarget[];
		try {
			const [resources, template] = await Promise.all([
				this.fetchResources(stackName, region),
				this.fetchTemplate(stackName, region),
			]);
			targets = discoverMetricTargets(resources, template, stackName);
		} catch (error) {
			return {
				stage,
				stackName,
				usageSource: 'unavailable',
				usageError: `Could not discover metric targets: ${error instanceof Error ? error.message : String(error)}`,
				usageErrorCode: classifyUsageError(error),
				awsContext,
				rangeMinutes,
				periodSeconds,
				estimate: emptyEstimate,
				targets: [],
			};
		}

		const queries = buildMetricQueries(targets, effectiveRegion);
		const estimate = toUsageEstimate(estimateCost(queries));
		const targetInfos = toUsageTargets(targets, queries);

		if (!confirmed) {
			// The gate. No GetMetricData call has been made and none will be.
			return {
				stage,
				stackName,
				usageSource: 'gated',
				awsContext,
				rangeMinutes,
				periodSeconds,
				estimate,
				targets: targetInfos,
			};
		}

		const end = new Date();
		const start = new Date(end.getTime() - rangeMinutes * 60_000);
		try {
			const results = await this.fetchMetricDataImpl(queries, start, end, periodSeconds);
			const series = mapMetricData(results, queries);
			return {
				stage,
				stackName,
				usageSource: 'cloudwatch',
				awsContext,
				rangeMinutes,
				periodSeconds,
				start: start.toISOString(),
				end: end.toISOString(),
				estimate,
				targets: targetInfos,
				series,
				totals: summarise(series),
				fetchedAt: new Date().toISOString(),
			};
		} catch (error) {
			return {
				stage,
				stackName,
				usageSource: 'unavailable',
				usageError: `Could not fetch usage metrics: ${error instanceof Error ? error.message : String(error)}`,
				usageErrorCode: classifyUsageError(error),
				awsContext,
				rangeMinutes,
				periodSeconds,
				start: start.toISOString(),
				end: end.toISOString(),
				estimate,
				targets: targetInfos,
			};
		}
	}

	/**
	 * Environment diagnosis. Read-only: it probes and reports, and changes
	 * nothing. Doctor holds its own judgement, so this is pure delegation.
	 */
	async diagnose(): Promise<DoctorResult> {
		return this.runDoctorImpl({ projectRoot: this.projectRoot });
	}

	private blocksCache: { at: number; result: BlocksResult } | undefined;

	/**
	 * Source-derived block inventory (M5). Unkeyed cache: discovery is scoped to
	 * this provider's single projectRoot, so there is nothing to key on.
	 * See {@link BLOCKS_CACHE_TTL_MS} for why the TTL is short.
	 */
	async listBlocks(): Promise<BlocksResult> {
		if (this.blocksCache && Date.now() - this.blocksCache.at < BLOCKS_CACHE_TTL_MS) {
			return this.blocksCache.result;
		}
		const result = this.discoverBlocksImpl({ projectRoot: this.projectRoot });
		this.blocksCache = { at: Date.now(), result };
		return result;
	}

	/**
	 * One page of a block's records (M5).
	 *
	 * Resolution order: declared block → mode → store.
	 *
	 * 1. `blockFullId` is looked up in {@link listBlocks}. An unknown id is
	 *    `BLOCK_NOT_FOUND` and NEITHER reader runs.
	 * 2. `local` reads the on-disk .blocks-data stores under projectRoot.
	 * 3. `cloud` resolves the stage's stack, reuses the Resources view's
	 *    block-labelled groups, and reads the deployed stores.
	 *
	 * Step 1 is a security guard, not tidiness. `blockFullId` arrives on the URL
	 * path, and both readers fall back to a sibling store when the requested one
	 * does not match exactly. Refusing an id that is not a declared block is
	 * what stops an arbitrary caller-supplied prefix resolving — through that
	 * fallback — to a store the caller never named. Keep the check ahead of both
	 * readers, and keep it a refusal rather than a best-effort read.
	 */
	async readData(params: DataPageParams): Promise<DataPageResult> {
		const { stage, mode, blockFullId, store, cursor, limit } = params;

		const { blocks } = await this.listBlocks();
		const block = blocks.find((candidate) => candidate.fullId === blockFullId);
		if (!block) {
			return {
				stage,
				mode,
				blockFullId,
				dataSource: 'unavailable',
				dataError: `No block with id "${blockFullId}" is declared in this app.`,
				dataErrorCode: 'BLOCK_NOT_FOUND',
				stores: [],
				keyFields: [],
				records: [],
				totalRecords: 0,
				totalRecordsExact: true,
				redacted: false,
			};
		}

		if (mode === 'local') {
			const page = this.readLocalDataImpl({
				projectRoot: this.projectRoot,
				blockFullId,
				...(store ? { store } : {}),
				...(cursor ? { cursor } : {}),
				...(limit !== undefined ? { limit } : {}),
				// The file stores its key serialized; only the block's declared
				// schema names the fields inside it, so pass it through or the key
				// column has no labels and keyValues cannot be filled in.
				...(block.keySchema ? { keySchema: block.keySchema } : {}),
			});
			// No awsContext on the local path: nothing here touched AWS.
			return { stage, mode, blockFullId, ...this.toDataPage(page) };
		}

		const { stackName, region, regionSource } = this.resolveStackTarget(stage);
		const awsContext = this.awsContextFor(region, regionSource);

		if (!stackName) {
			// Not an error code: an undeployed stage is a normal state, and
			// labelling it an error would put a red banner over "you have not
			// deployed yet".
			return {
				stage,
				mode,
				blockFullId,
				dataSource: 'unavailable',
				dataError: `Stage "${stage}" is not deployed, so there are no cloud stores to read. Deploy it, or switch to local data.`,
				awsContext,
				stores: [],
				keyFields: [],
				records: [],
				totalRecords: 0,
				totalRecordsExact: true,
				redacted: false,
			};
		}

		// Reuse the Resources view rather than re-fetching the template: the
		// groups must be the same block-labelled ones the user sees there, or a
		// block could be readable in one view and missing in the other.
		const resources = await this.listResources(stage);
		if (resources.resourcesSource === 'unavailable') {
			// The stack exists but could not be read (credentials, permissions).
			// Reported as-is: handing empty groups to the reader would surface
			// this as "store not found" and hide the real cause.
			return {
				stage,
				mode,
				blockFullId,
				dataSource: 'unavailable',
				...(resources.resourcesError ? { dataError: resources.resourcesError } : {}),
				...(resources.resourcesErrorCode ? { dataErrorCode: resources.resourcesErrorCode } : {}),
				awsContext,
				stores: [],
				keyFields: [],
				records: [],
				totalRecords: 0,
				totalRecordsExact: true,
				redacted: false,
			};
		}

		const page = await this.readCloudDataImpl({
			block,
			groups: resources.groups,
			...(store ? { store } : {}),
			...(cursor ? { cursor } : {}),
			...(limit !== undefined ? { limit } : {}),
			...(region ? { region } : {}),
		});
		return { stage, mode, blockFullId, awsContext, ...this.toDataPage(page) };
	}

	/**
	 * Reader page → contract fields. The reader owns `source`/`error`/`errorCode`
	 * under its own names; the response spells them `data*`.
	 */
	private toDataPage(page: DataPage): Omit<DataPageResult, 'stage' | 'mode' | 'blockFullId' | 'awsContext'> {
		return {
			dataSource: page.source,
			...(page.error ? { dataError: page.error } : {}),
			...(page.errorCode ? { dataErrorCode: toContractErrorCode(page.errorCode) } : {}),
			stores: page.stores,
			...(page.activeStore ? { activeStore: page.activeStore } : {}),
			keyFields: page.keyFields,
			records: page.records,
			...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
			totalRecords: page.totalRecords,
			totalRecordsExact: page.totalRecordsExact,
			redacted: page.redacted,
		};
	}

	/**
	 * Create or replace one record (M6).
	 *
	 * Same resolution order as {@link readData}, and step 1 is the same security
	 * guard for the same reason: `blockFullId` arrives on the URL path, and the
	 * writers fall back to a default store when the requested one is absent.
	 * Refusing an id that is not a declared block is what stops a
	 * caller-supplied prefix resolving — through that fallback — to a store the
	 * caller never named. On a write the consequence is a mutation of the wrong
	 * table, so this check stays ahead of both writers.
	 *
	 * This method deliberately does NOT consult the write-unlock gate. That
	 * check is enforced in the route, so it applies to a request rather than to
	 * an internal call, and so a future non-HTTP caller cannot inherit
	 * "unlocked" from a browser session that happens to be open.
	 */
	async writeRecord(params: RecordWriteParams): Promise<WriteResult> {
		const target = await this.resolveWriteTarget(params);
		if (target.kind === 'refused') return target.result;
		if (target.kind === 'local') {
			return this.toWriteResult(await this.putLocalRecordImpl(target.context, params.item, params.writeMode));
		}
		return this.toWriteResult(await this.putCloudRecordImpl(target.context, params.item, params.writeMode));
	}

	/** Delete one record by key. See {@link writeRecord} on the block guard and the unlock gate. */
	async deleteRecord(params: RecordDeleteParams): Promise<WriteResult> {
		const target = await this.resolveWriteTarget(params);
		if (target.kind === 'refused') return target.result;
		if (target.kind === 'local') {
			return this.toWriteResult(await this.deleteLocalRecordImpl(target.context, params.keyValues));
		}
		return this.toWriteResult(await this.deleteCloudRecordImpl(target.context, params.keyValues));
	}

	/**
	 * The app's callable RPC surface (M7).
	 *
	 * Built from the block list {@link listBlocks} already caches, deliberately
	 * rather than from a fresh scan: the catalogue and the blocks view then agree
	 * by construction, and opening the playground does not re-parse the app's
	 * source on a schedule of its own.
	 */
	async listRpcMethods(): Promise<RpcMethodsResult> {
		const { blocks } = await this.listBlocks();
		return this.buildRpcMethodCatalogueImpl(this.projectRoot, blocks);
	}

	/**
	 * Call one method on the app's own RPC endpoint (M7).
	 *
	 * Resolve, then invoke. An unresolvable endpoint is converted to a RESULT
	 * here — `transportErrorCode: 'NO_ENDPOINT'`, `httpStatus: 0`, `endpoint: ''`
	 * and the resolver's own message as the body — and never thrown: "there is no
	 * endpoint for this stage yet" is an answer the playground should render
	 * beside its request, not an exception the route has to catch and relabel.
	 * The same reasoning is why the invoker reports a timeout inside its result.
	 *
	 * `stage` and `mode` are echoed onto both paths. The UI must be able to prove
	 * which environment answered; a result that cannot say where it came from is
	 * the one thing a playground must never produce, so neither the success nor
	 * the failure path is allowed to omit them.
	 */
	async invokeRpc(params: RpcInvokeParams): Promise<RpcInvokeResult> {
		const { stage, mode, method } = params;
		// Region comes from the deploy record for this stage when there is one,
		// exactly as the cloud read and write paths resolve it.
		const { region } = this.resolveStackTarget(stage);
		const resolution = await this.resolveRpcEndpointImpl({
			projectRoot: this.projectRoot,
			stage,
			mode,
			...(region ? { region } : {}),
		});
		if (!resolution.ok) {
			return {
				stage,
				mode,
				endpoint: '',
				ok: false,
				httpStatus: 0,
				durationMs: 0,
				body: resolution.message,
				transportErrorCode: resolution.code,
			};
		}

		const result = await this.invokeRpcImpl({
			endpoint: resolution.endpoint,
			method,
			// Positional, and passed through untouched: reshaping them would guess
			// at an argument order the dashboard has no authority to guess.
			params: params.params,
		});
		return { stage, mode, ...result };
	}

	async listSettings(params: SettingsParams): Promise<SettingsResult> {
		const { stage, mode } = params;
		const discovery = await this.listBlocks();

		if (mode === 'local') {
			const values = this.readLocalSettingsImpl(this.projectRoot);
			const inventory = joinSettings({ blocks: discovery.blocks, mode, live: [...values.keys()] });
			return {
				stage,
				mode,
				settings: inventory.settings.map((row) =>
					buildLocalSettingEntry(row, values.has(row.fullId), values.get(row.fullId)),
				),
				orphans: inventory.orphans,
			};
		}

		const { stackName, region } = this.resolveStackTarget(stage);
		if (!stackName) {
			return {
				stage,
				mode,
				settings: [],
				orphans: [],
				settingsError: `No CloudFormation stack could be resolved for stage "${stage}". Deploy it first, then reload.`,
				settingsErrorCode: 'NOT_DEPLOYED',
			};
		}

		try {
			const template = await this.fetchTemplate(stackName, region);
			// The template is read for three reasons: the names of the secrets,
			// which no `AWS::SSM::Parameter` resource carries; the handler
			// environment shown read-only beside the settings; and the actual
			// parameter PATHS, which a source scan cannot derive because a
			// deployed `fullId` is stack-prefixed.
			const fromTemplate = templateParameterNames(template);
			const addresses = new Map<string, string>();
			for (const block of declaredSettings(discovery.blocks)) {
				const declaration = block.setting;
				if (!declaration) continue;
				const address = cloudAddressFor(declaration, block.fullId, fromTemplate.names, stackName);
				if (address !== undefined) addresses.set(block.fullId, address);
			}
			const candidates = [...new Set([...addresses.values(), ...fromTemplate.names])];
			// Queried by name, which is what makes "absent" a settled answer:
			// a name the account does not hold is simply missing from the reply.
			const stored = await this.fetchParameterValuesImpl(candidates, region);
			const inventory = joinSettings({
				blocks: discovery.blocks,
				mode,
				live: [...stored.keys()],
				addresses,
			});
			return {
				stage,
				mode,
				settings: inventory.settings.map((row) =>
					buildSettingEntry(row, row.address === undefined ? undefined : stored.get(row.address)),
				),
				orphans: inventory.orphans,
				environment: templateHandlerEnvironment(template),
			};
		} catch (error) {
			const classified = classifyReadError(error);
			return {
				stage,
				mode,
				settings: [],
				orphans: [],
				settingsError: classified.message,
				settingsErrorCode: classified.code,
			};
		}
	}

	async revealSetting(params: SettingTargetParams): Promise<SettingRevealResult | undefined> {
		const { stage, mode, fullId } = params;
		const declaration = await this.findDeclaredSetting(fullId);
		// An unknown id reads as "not held" rather than as an error: the one
		// thing this must never do is take an address from the caller, which
		// would turn the route into a reader for every parameter in the account.
		if (!declaration) return undefined;

		if (mode === 'local') {
			const values = this.readLocalSettingsImpl(this.projectRoot);
			if (!values.has(fullId)) return undefined;
			const value = values.get(fullId);
			// The mock file holds decoded values, so there is no encoding to
			// read back: the file itself is the JSON.
			return {
				fullId,
				display: typeof value === 'string' ? value : JSON.stringify(value),
				encoding: 'json',
			};
		}

		const address = await this.resolveCloudAddress(stage, declaration);
		if (address === undefined) return undefined;
		const { region } = this.resolveStackTarget(stage);
		const stored = await this.fetchDecryptedParameterImpl(address, region);
		if (!stored || stored.raw === undefined) return undefined;
		const decoded = decodeSettingValue(stored.raw);
		const result: SettingRevealResult = {
			fullId,
			display: typeof decoded.value === 'string' ? decoded.value : JSON.stringify(decoded.value),
			encoding: decoded.encoding,
		};
		if (stored.version !== undefined) result.version = stored.version;
		if (stored.lastModified !== undefined) result.lastModified = stored.lastModified;
		return result;
	}

	async listSettingVersions(params: SettingTargetParams): Promise<SettingHistoryResult> {
		const { stage, mode, fullId } = params;
		const declaration = await this.findDeclaredSetting(fullId);
		const secret = declaration?.setting?.secret ?? true;
		// Local mode keeps one value per setting in a plain JSON file, so there
		// is no history to offer. Reported as an empty list rather than as an
		// error, because "no previous versions here" is the truth.
		if (!declaration || mode === 'local') return { fullId, secret, versions: [] };
		const address = await this.resolveCloudAddress(stage, declaration);
		if (address === undefined) return { fullId, secret, versions: [] };
		const { region } = this.resolveStackTarget(stage);
		return { fullId, secret, versions: await this.fetchParameterHistoryImpl(address, secret, region) };
	}

	async writeSetting(params: SettingWriteParams): Promise<SettingWriteResult> {
		const { stage, mode, fullId, input, kind } = params;
		const declaration = await this.findDeclaredSetting(fullId);
		const schemaUnchecked = declaration?.setting?.hasSchema ?? false;
		const refuse = (refusalCode: SettingWriteRefusal, message: string): SettingWriteResult => ({
			fullId,
			stage,
			mode,
			ok: false,
			refusalCode,
			message,
			schemaUnchecked,
		});

		if (!declaration?.setting) {
			return refuse('not-declared', `No setting named "${fullId}" is declared in this app.`);
		}
		const secret = declaration.setting.secret;

		const encoded = encodeSettingValue(input, kind, { secret });
		if (!encoded.ok) return refuse(encoded.reason, encoded.message);

		if (mode === 'local') {
			// Stored decoded, which is what the mock does: the file IS the JSON.
			this.writeLocalSettingImpl(this.projectRoot, fullId, encoded.value);
			return {
				fullId,
				stage,
				mode,
				ok: true,
				message: `Saved to .bb-data/settings.json. The next local run reads the new value.`,
				stored: storedView(encoded.value, secret),
				schemaUnchecked,
			};
		}

		const address = await this.resolveCloudAddress(stage, declaration);
		if (address === undefined) {
			return refuse(
				'unaddressable',
				declaration.setting.nameSource === 'unresolved'
					? `"${fullId}" names its parameter with a variable, so its path cannot be read from source. Set it where it is seeded, or give the declaration a literal name.`
					: `The ${stage} stack creates no parameter for "${fullId}". Deploy the stage first: a write cannot create a parameter whose path the stack has not fixed.`,
			);
		}

		const { region } = this.resolveStackTarget(stage);
		try {
			if (params.expectedVersion !== undefined) {
				const current = await this.fetchParameterValuesImpl([address], region);
				const live = current.get(address)?.version;
				if (live !== undefined && live !== params.expectedVersion) {
					return refuse(
						'version-conflict',
						`That setting changed since you read it (you saw version ${params.expectedVersion}, it is now ${live}). Reload before saving so you do not overwrite the newer value.`,
					);
				}
			}
			const version = await this.putParameterImpl(address, encoded.encoded, { secret }, region);
			const stored = storedView(encoded.value, secret);
			if (version !== undefined) stored.version = version;
			return {
				fullId,
				stage,
				mode,
				ok: true,
				message: `Saved to ${address}. The app reads the new value at its next read; a running Lambda holding it in memory keeps the old one until it is replaced.`,
				stored,
				schemaUnchecked,
			};
		} catch (error) {
			const classified = classifyReadError(error);
			return refuse('unreachable', classified.message);
		}
	}

	/**
	 * The declared setting one `fullId` names, or undefined.
	 *
	 * Every settings operation resolves the caller's id through this rather than
	 * accepting a parameter path, so the reachable set is exactly what the app
	 * declares.
	 */
	private async findDeclaredSetting(fullId: string): Promise<DiscoveredBlock | undefined> {
		const discovery = await this.listBlocks();
		return declaredSettings(discovery.blocks).find((block) => block.fullId === fullId);
	}

	/**
	 * The deployed SSM path for one declared setting in one stage.
	 *
	 * Shared by the reveal, the history and the write so the three cannot drift
	 * from the listing, which is how one of them would end up reading a
	 * stack-prefixed path while another wrote the bare one. It costs a template
	 * fetch per call, which is the price of not guessing: the prefix is decided
	 * at synth time and exists nowhere in the app's source.
	 */
	private async resolveCloudAddress(
		stage: string,
		declaration: DiscoveredBlock,
	): Promise<string | undefined> {
		if (!declaration.setting) return undefined;
		const { stackName, region } = this.resolveStackTarget(stage);
		if (!stackName) return undefined;
		try {
			const template = await this.fetchTemplate(stackName, region);
			const { names } = templateParameterNames(template);
			return cloudAddressFor(declaration.setting, declaration.fullId, names, stackName);
		} catch {
			// The caller reports the failure in its own terms (undefined reads as
			// "no value held" on a reveal, and as a refusal on a write), so a
			// throw here would turn a legible answer into a crash.
			return undefined;
		}
	}

	/**
	 * Resolves a write to a concrete store context, or to a refusal.
	 *
	 * Shared by {@link writeRecord} and {@link deleteRecord} so the two cannot
	 * drift: a guard that applied to a put but not to a delete would be worse
	 * than no guard, because the delete is the more destructive of the pair.
	 */
	private async resolveWriteTarget(params: {
		stage: string;
		mode: DataMode;
		blockFullId: string;
		store?: string;
	}): Promise<WriteTarget> {
		const { stage, mode, blockFullId, store } = params;

		const { blocks } = await this.listBlocks();
		const block = blocks.find((candidate) => candidate.fullId === blockFullId);
		if (!block) {
			return {
				kind: 'refused',
				result: {
					ok: false,
					message: `No block with id "${blockFullId}" is declared in this app, so there is nothing to write to.`,
					refusalCode: 'NOT_FOUND',
				},
			};
		}

		if (mode === 'local') {
			return {
				kind: 'local',
				context: {
					projectRoot: this.projectRoot,
					blockFullId,
					...(store ? { store } : {}),
					// The file stores its key serialized; only the block's declared
					// schema names the fields inside it, so the writer needs it to
					// address an existing record rather than append a duplicate.
					...(block.keySchema ? { keySchema: block.keySchema } : {}),
				},
			};
		}

		const { stackName, region } = this.resolveStackTarget(stage);
		if (!stackName) {
			// No refusal: an undeployed stage is a normal state, exactly as in
			// readData. Labelling it a refusal *code* would have the UI render
			// "you have not deployed yet" as a policy rejection.
			return {
				kind: 'refused',
				result: {
					ok: false,
					message: `Stage "${stage}" is not deployed, so there are no cloud stores to write to. Deploy it, or switch to local data.`,
				},
			};
		}

		// Reuse the Resources view, as readData does: the groups must be the same
		// block-labelled ones the user sees there, or a block could be writable in
		// one view and missing in the other.
		const resources = await this.listResources(stage);
		if (resources.resourcesSource === 'unavailable') {
			// The stack exists but could not be read (credentials, permissions).
			// Forwarded as-is: handing empty groups to the writer would surface a
			// credentials problem as "store not found" and hide the real cause.
			return {
				kind: 'refused',
				result: {
					ok: false,
					message:
						resources.resourcesError ??
						`Could not resolve the stores for stage "${stage}", so no write was attempted.`,
				},
			};
		}

		return {
			kind: 'cloud',
			context: {
				block,
				groups: resources.groups,
				...(store ? { store } : {}),
				...(region ? { region } : {}),
			},
		};
	}

	/**
	 * Writer result → contract result.
	 *
	 * Both codes are forwarded. `refusalCode` says the request was refused on its
	 * merits (change the request); `errorCode` says the environment failed
	 * (fix credentials, permissions, or the missing table). The cloud writer
	 * classifies its failures and that classification used to be dropped here for
	 * want of a contract field, which made an IAM denial indistinguishable from a
	 * dropped table in cloud mode while the local path reported both precisely.
	 */
	private toWriteResult(result: WriterResult): WriteResult {
		return {
			ok: result.ok,
			message: result.message,
			...(result.refusalCode ? { refusalCode: result.refusalCode } : {}),
			...('errorCode' in result && result.errorCode ? { errorCode: result.errorCode } : {}),
		};
	}

	/**
	 * Stack naming scheme (mirrors core's getStackName, D-012):
	 * production → `<stackId>-prod`; sandbox → `<stackId>-<sandboxId>` with
	 * the sandbox id read (never created) from .blocks-sandbox/sandbox-id.txt.
	 */
	private resolveStackName(stage: string): string | undefined {
		const stackId = this.readStackId();
		if (!stackId) return undefined;
		if (stage === 'production') return `${stackId}-prod`;
		if (stage === 'sandbox') {
			const idFile = join(this.projectRoot, '.blocks-sandbox', 'sandbox-id.txt');
			if (!existsSync(idFile)) return undefined;
			const sandboxId = readFileSync(idFile, 'utf-8').trim();
			return sandboxId ? `${stackId}-${sandboxId}` : undefined;
		}
		return undefined;
	}

	private readStackId(): string | undefined {
		try {
			const config = JSON.parse(readFileSync(join(this.projectRoot, '.blocks', 'config.json'), 'utf-8'));
			return typeof config.stackId === 'string' && config.stackId ? config.stackId : undefined;
		} catch {
			return undefined;
		}
	}

	private readProjectName(): string {
		try {
			const pkg = JSON.parse(readFileSync(join(this.projectRoot, 'package.json'), 'utf-8'));
			if (typeof pkg.name === 'string' && pkg.name.length > 0) return pkg.name;
		} catch {
			// No/invalid package.json — fall back to the directory name.
		}
		return basename(this.projectRoot);
	}

	private readStages(): StageInfo[] {
		// Blocks today knows exactly two stages. A richer stage model is a
		// separate core work stream; the dashboard renders what exists.
		const stages: StageInfo[] = [{ name: 'sandbox' }, { name: 'production' }];
		try {
			const config = JSON.parse(readFileSync(join(this.projectRoot, '.blocks', 'config.json'), 'utf-8'));
			if (typeof config.stackId === 'string') {
				for (const s of stages) s.stackName = config.stackId;
			}
		} catch {
			// Not deployed yet — stages stay unresolved.
		}
		return stages;
	}

	private readDeployHistory(): DeploymentRecord[] {
		const historyPath = join(this.projectRoot, '.blocks', 'deploy-history.jsonl');
		if (!existsSync(historyPath)) return [];
		// Each deploy appends an IN_PROGRESS record at start and a terminal
		// record with the same id at the end — merge by id, last record wins.
		// A dangling IN_PROGRESS record (process died mid-deploy) stays visible.
		const byId = new Map<string, DeploymentRecord>();
		for (const line of readFileSync(historyPath, 'utf-8').split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed);
				if (typeof parsed.id !== 'string' || parsed.id.length === 0) continue;
				byId.set(parsed.id, { source: 'deploy-history', ...parsed });
			} catch {
				// Skip corrupt lines rather than failing the whole view.
			}
		}
		// Newest first.
		return [...byId.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
	}
}
