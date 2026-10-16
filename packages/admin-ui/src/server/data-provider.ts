// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
	BlocksResponse,
	CostResponse,
	DataMode,
	DataPageResponse,
	DeploymentDetailResponse,
	DeploymentRecord,
	DoctorResponse,
	EnvironmentsResponse,
	LogGroupsResponse,
	LogSearchParams,
	LogSearchResponse,
	ResourcesResponse,
	RpcInvokeResponse,
	RpcMethodsResponse,
	SettingHistoryResponse,
	SettingRevealResponse,
	SettingsResponse,
	SettingValueKind,
	SettingWriteResponse,
	StageInfo,
	UsageResponse,
	WriteMode,
	WriteResponse,
} from '../contract/v1.js';

/**
 * Swappable backend behind the Dashboard API.
 *
 * The local Node server uses {@link LocalDataProvider} (reads .blocks state
 * and calls AWS with the developer's credentials). A future in-account
 * deployment swaps in a Lambda-backed provider without touching the SPA
 * or the route handlers.
 */
export interface DataProvider {
	getProjectMeta(): Promise<ProjectMeta>;
	listDeployments(stage?: string): Promise<DeploymentRecord[]>;
	/** Deployment drill-down with CFN failure events; undefined if id unknown. */
	getDeployment(id: string): Promise<DeploymentDetail | undefined>;
	/** Log groups belonging to the stage's stack (M2 discovery). */
	listLogGroups(stage: string): Promise<LogGroupsResult>;
	/** Faceted log search across the stage's log groups (M2). */
	searchLogs(params: LogSearchParams): Promise<LogSearchResult>;
	/** Resource inventory grouped by owning block/construct (M3). */
	listResources(stage: string): Promise<ResourcesResult>;
	/** Per-stage stack state, read-only (M3). */
	listEnvironments(): Promise<EnvironmentsResult>;
	/** Cost view with the attribution ladder (M4). */
	getCost(stage: string): Promise<CostResult>;
	/**
	 * Usage metrics for one stage (M8).
	 *
	 * `params.confirmed` is passed IN rather than consulted here, for the same
	 * reason {@link writeRecord} does not consult the write unlock: deciding
	 * whether a caller has consented is the route's job, because only the route
	 * sees a request. What the provider owns is the consequence — with
	 * `confirmed: false` it discovers and prices the query set and makes no
	 * billable call, which is a guarantee of this method rather than of the
	 * route that calls it.
	 */
	getUsage(params: UsageParams): Promise<UsageResult>;
	/** Environment diagnosis: what was detected, changing nothing (M4). */
	diagnose(): Promise<DoctorResult>;
	/** Source-derived inventory of the blocks the app declares (M5). */
	listBlocks(): Promise<BlocksResult>;
	/** One page of a block's records, local or cloud (M5). */
	readData(params: DataPageParams): Promise<DataPageResult>;
	/**
	 * Create or replace one record in a block's store (M6).
	 *
	 * Note what is NOT here: the write-unlock gate. That check lives in the
	 * route, so it applies to a *request* rather than to an internal call — and
	 * so a future non-HTTP caller (a CLI command, a script, another provider)
	 * cannot accidentally inherit "unlocked" from somebody's browser session.
	 * A provider method is not the right place to consult per-session state.
	 */
	writeRecord(params: RecordWriteParams): Promise<WriteResult>;
	/** Delete one record by its key attributes (M6). See {@link writeRecord} on the unlock gate. */
	deleteRecord(params: RecordDeleteParams): Promise<WriteResult>;
	/**
	 * Catalogue of the ApiNamespace methods the app declares (M7).
	 *
	 * A read, and derived from the same block inventory {@link listBlocks}
	 * already caches — the playground must not put the app's source on a second,
	 * independent parse schedule.
	 */
	listRpcMethods(): Promise<RpcMethodsResult>;
	/**
	 * Call one method on the app's own RPC endpoint (M7).
	 *
	 * Note what is NOT here, and unlike {@link writeRecord} it is absent from the
	 * route as well: the write-unlock gate. The unlock exists because a direct
	 * DynamoDB write BYPASSES the app's validation, auth and business logic —
	 * power the app grants nobody. An RPC call goes THROUGH all of it and is
	 * exactly what any client holding the endpoint can already do, so gating it
	 * would misrepresent where the risk is. See the route for the full rationale.
	 *
	 * Never rejects for a call that was attempted: an upstream 401, a JSON-RPC
	 * error body, a timeout and an unresolvable endpoint are all outcomes
	 * reported *inside* the result.
	 */
	invokeRpc(params: RpcInvokeParams): Promise<RpcInvokeResult>;
	/**
	 * Declared settings joined against one stage, with every value masked (M9).
	 *
	 * Masked HERE rather than at the route, because the guarantee belongs to the
	 * method: no call to this function decrypts a SecureString, so no caller can
	 * obtain one through it by accident. Revealing is a separate method with a
	 * separate route, which is what makes "the list cannot leak a secret" a
	 * property of the code rather than of the UI's restraint.
	 */
	listSettings(params: SettingsParams): Promise<SettingsResult>;
	/**
	 * One setting's value, decrypted, for a reveal asked for by name (M9).
	 *
	 * Undefined when the stage does not hold it. Single-parameter by
	 * construction: a bulk decrypted read is the shape that turns one careless
	 * click into every secret the app has.
	 */
	revealSetting(params: SettingTargetParams): Promise<SettingRevealResult | undefined>;
	/** Versions of one setting, newest first, so a rollback is not a guess (M9). */
	listSettingVersions(params: SettingTargetParams): Promise<SettingHistoryResult>;
	/**
	 * Store one setting's value (M9).
	 *
	 * Note what is NOT here, matching {@link writeRecord}: the unlock gate and
	 * the production confirmation. Both are checks on a *request*, so they live
	 * in the route, and keeping them out means a future non-HTTP caller cannot
	 * inherit either from a browser session somebody left open.
	 *
	 * What IS here is every consequence: the id is resolved against declared
	 * settings, the value is encoded exactly as `AppSetting.put()` encodes it,
	 * and a secret stays a SecureString. Refusals come back inside the result
	 * rather than as rejections, because every one of them is something the
	 * user has to act on rather than a fault.
	 */
	writeSetting(params: SettingWriteParams): Promise<SettingWriteResult>;
}

/** Arguments for one settings listing. */
export interface SettingsParams {
	stage: string;
	mode: DataMode;
}

/** Arguments for an operation on ONE declared setting, named by its `fullId`. */
export interface SettingTargetParams extends SettingsParams {
	/**
	 * Caller-supplied, so it is resolved against DECLARED settings before any
	 * parameter is touched. The alternative (taking a parameter path from the
	 * request) would let any caller read any SSM parameter in the account
	 * through this route, which is a much larger grant than the feature needs.
	 */
	fullId: string;
}

/**
 * Arguments for one RPC invocation.
 *
 * `params` is POSITIONAL, matching the JSON-RPC wire format the app speaks. It
 * is an array here rather than an object because that is what goes on the wire;
 * accepting an object and reshaping it would guess at an argument order the
 * dashboard has no authority to guess.
 */
export interface RpcInvokeParams {
	stage: string;
	mode: DataMode;
	/** `namespace.methodName`. */
	method: string;
	params: unknown[];
}

/**
 * Arguments for one data page read.
 *
 * `blockFullId` is caller-supplied (it arrives on the URL path), so the
 * provider resolves it against declared blocks before touching any store —
 * see {@link DataProvider.readData}.
 */
export interface DataPageParams {
	stage: string;
	mode: DataMode;
	blockFullId: string;
	/** Store id as reported in a previous page's `stores`; a default is picked when absent. */
	store?: string;
	/** Opaque continuation token from a previous page. */
	cursor?: string;
	limit?: number;
}

/**
 * Arguments for one record write.
 *
 * `blockFullId` is caller-supplied exactly as in {@link DataPageParams}, and is
 * resolved against declared blocks before any store is touched — the stakes are
 * strictly higher here than on a read.
 */
export interface RecordWriteParams {
	stage: string;
	mode: DataMode;
	blockFullId: string;
	/** Store id as reported by a data page; a default is picked when absent. */
	store?: string;
	writeMode: WriteMode;
	item: Record<string, unknown>;
}

/** Arguments for one record delete. */
export interface RecordDeleteParams {
	stage: string;
	mode: DataMode;
	blockFullId: string;
	/** Store id as reported by a data page; a default is picked when absent. */
	store?: string;
	/** Key attributes by name; taken from `DataRecord.keyValues`. */
	keyValues: Record<string, string>;
}

/** getDeployment result — the detail response minus the envelope field. */
export type DeploymentDetail = Omit<DeploymentDetailResponse, 'apiVersion'>;

/** listLogGroups result — the response minus the envelope field. */
export type LogGroupsResult = Omit<LogGroupsResponse, 'apiVersion'>;

/** searchLogs result — the response minus the envelope field. */
export type LogSearchResult = Omit<LogSearchResponse, 'apiVersion'>;

/** listResources result — the response minus the envelope field. */
export type ResourcesResult = Omit<ResourcesResponse, 'apiVersion'>;

/** listEnvironments result — the response minus the envelope field. */
export type EnvironmentsResult = Omit<EnvironmentsResponse, 'apiVersion'>;

/** getCost result — the response minus the envelope field. */
export type CostResult = Omit<CostResponse, 'apiVersion'>;

/**
 * Arguments for one usage read.
 *
 * `confirmed` is the caller's consent to a PRICED call, resolved by the route
 * from the request. False means discover and estimate only: see
 * {@link DataProvider.getUsage}.
 */
export interface UsageParams {
	stage: string;
	/** Window to chart, in minutes. The period is derived from it, not chosen. */
	rangeMinutes: number;
	/** True only when the caller has explicitly accepted the estimated charge. */
	confirmed: boolean;
}

/**
 * getUsage result — the response minus the envelope field.
 *
 * A stage that cannot be read reports it INSIDE the result (`usageSource:
 * 'unavailable'` plus a code), never as a rejection, matching every other
 * pillar: "no stack deployed here" is an answer, not a failure.
 */
export type UsageResult = Omit<UsageResponse, 'apiVersion'>;

/** diagnose result — the response minus the envelope field. */
export type DoctorResult = Omit<DoctorResponse, 'apiVersion'>;

/**
 * listBlocks result — the response minus the envelope field.
 *
 * `block-discovery.ts` exports a structurally identical alias; this one is the
 * provider's own vocabulary, declared here like every other pillar so the
 * interface does not depend on which module happens to implement it.
 */
export type BlocksResult = Omit<BlocksResponse, 'apiVersion'>;

/**
 * readData result — the response minus the envelope field.
 *
 * A store-level problem is reported *inside* this result (`dataSource:
 * 'unavailable'` plus `dataErrorCode`), not thrown: the request succeeded and
 * the answer is "that store cannot be read".
 */
export type DataPageResult = Omit<DataPageResponse, 'apiVersion'>;

/**
 * writeRecord / deleteRecord result — the response minus the envelope field.
 *
 * A refusal travels *inside* this result (`ok: false` plus a `refusalCode`),
 * never as a rejection: "the dev server holds this store" and "that record
 * already exists" are answers, not failures.
 */
export type WriteResult = Omit<WriteResponse, 'apiVersion'>;

/** listRpcMethods result — the response minus the envelope field. */
export type RpcMethodsResult = Omit<RpcMethodsResponse, 'apiVersion'>;

/**
 * invokeRpc result — the response minus the envelope field.
 *
 * Carries `stage` and `mode` back out, so a caller can prove which environment
 * answered. A playground that cannot say where a result came from is the one
 * thing it must never be, and the echo is therefore part of the result type
 * rather than something the route reconstructs from the request it happens to
 * still have in scope.
 */
export type RpcInvokeResult = Omit<RpcInvokeResponse, 'apiVersion'>;

/** Settings listing minus the envelope field the route adds. */
export type SettingsResult = Omit<SettingsResponse, 'apiVersion'>;

/** One revealed value minus the envelope field the route adds. */
export type SettingRevealResult = Omit<SettingRevealResponse, 'apiVersion'>;

/** One setting's version list minus the envelope field the route adds. */
export type SettingHistoryResult = Omit<SettingHistoryResponse, 'apiVersion'>;

/** One setting write minus the envelope field the route adds. */
export type SettingWriteResult = Omit<SettingWriteResponse, 'apiVersion'>;

/** Arguments for one setting write. */
export interface SettingWriteParams extends SettingTargetParams {
	/** The user's input, exactly as typed. */
	input: string;
	/**
	 * How to read `input`. Never inferred: inferring it is what turns the text
	 * `5` into the number 5 behind the user's back.
	 */
	kind: SettingValueKind;
	/**
	 * The version the caller believes is current, when it read one.
	 *
	 * Checked by reading before writing, which is NOT atomic: SSM has no
	 * conditional put, so a write that lands between the two calls is not
	 * caught. It still turns the common case (two tabs, a stale form) from a
	 * silent clobber into a refusal, which is why it is here rather than
	 * omitted for being imperfect.
	 */
	expectedVersion?: number;
}

export interface ProjectMeta {
	projectName: string;
	projectRoot: string;
	stages: StageInfo[];
}
