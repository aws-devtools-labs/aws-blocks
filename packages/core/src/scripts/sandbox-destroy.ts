// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The sandbox destroy's retry loop and its AWS lookups. Kept out of the `scripts`
// entry's type surface: these signatures name AWS SDK client types, and a module
// re-exported from the entry would load the SDK's declarations into every app's
// typecheck. `sandbox.ts` and `destroy.ts` import this module at runtime only.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertAwsCredentials } from './preflight-credentials.js';
import { resolveDeploymentTarget } from './deployment-target.js';
import { createCdkOutput } from './cdk-output.js';
import { log } from './log.js';
import type { AssemblyStack, DestroyRetryDeps, ThrottleBackoff } from './destroy-retry-types.js';

export type { AssemblyStack, DestroyRetryDeps, ThrottleBackoff } from './destroy-retry-types.js';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import type { S3Client } from '@aws-sdk/client-s3';

/**
 * Where `sandbox:destroy` has CDK write the assembly it synthesizes (`--output`),
 * relative to the project root. The retry reads the stack list from it. Its own
 * directory, so a production `destroy` running at the same time can't clear it.
 */
export const SANDBOX_DESTROY_ASSEMBLY_DIR = '.blocks-sandbox/sandbox-destroy.out';

/**
 * Flatten a ListObjectVersions response into the `{ Key, VersionId }[]` shape
 * DeleteObjects expects, combining live versions AND delete markers. Exported
 * for unit testing — getting this combination wrong (e.g. missing the delete
 * markers) leaves a "versioned" bucket that still can't be deleted.
 */
export function toDeleteObjects(listed: {
	Versions?: Array<{ Key?: string; VersionId?: string }>;
	DeleteMarkers?: Array<{ Key?: string; VersionId?: string }>;
}): Array<{ Key: string; VersionId?: string }> {
	return [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])]
		.filter((v): v is { Key: string; VersionId?: string } => v.Key !== undefined)
		.map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
}

/** Collect a stack's S3 bucket physical names (paginated — a large stack has
 * >100 resources, so a single page can miss the hosting bucket that blocks the
 * delete). Returns [] if the stack is already gone / not accessible. */
export async function listStackBucketNames(cfn: CloudFormationClient, stackName: string): Promise<string[]> {
	const { ListStackResourcesCommand } = await import('@aws-sdk/client-cloudformation');
	const buckets: string[] = [];
	let token: string | undefined;
	do {
		const res = await cfn.send(new ListStackResourcesCommand({ StackName: stackName, NextToken: token }));
		for (const r of res.StackResourceSummaries ?? []) {
			if (r.ResourceType === 'AWS::S3::Bucket' && r.PhysicalResourceId) buckets.push(r.PhysicalResourceId);
		}
		token = res.NextToken;
	} while (token);
	return buckets;
}

/**
 * Resource types CloudFormation Express Mode can't UPDATE. Re-pointing a
 * Lambda Web Function endpoint's `RevisionWeights` at a new revision fails
 * there with "RevisionWeights: expected minimum item count: 1, found: 0" (a
 * plain update with rollback succeeds), and Express Mode's disabled rollback
 * then leaves the stack stuck in UPDATE_FAILED. Creates are unaffected.
 */
export const EXPRESS_UNSAFE_RESOURCE_TYPES: ReadonlySet<string> = new Set(['AWS::Lambda::WebFunctionEndpoint']);


/** A stack artifact in a cloud assembly's `manifest.json`. */
type StackArtifact = {
	type?: string;
	environment?: string;
	displayName?: string;
	properties?: { templateFile?: string; stackName?: string };
};

/**
 * The stack artifacts listed in `manifest.json` of the synthesized assembly at
 * `assemblyDir`, as `[artifactId, artifact]`: the top-level stacks (a stack
 * inside a CDK `Stage` lives in a nested assembly and is not listed). [] if the
 * assembly can't be read.
 */
function readStackArtifacts(assemblyDir: string): Array<[string, StackArtifact]> {
	let artifacts: Record<string, StackArtifact>;
	try {
		artifacts = (JSON.parse(readFileSync(join(assemblyDir, 'manifest.json'), 'utf-8')) as { artifacts?: Record<string, StackArtifact> })
			.artifacts ?? {};
	} catch {
		return [];
	}
	return Object.entries(artifacts).filter(([, artifact]) => artifact.type === 'aws:cloudformation:stack');
}

/** The CloudFormation stack name and Region of a stack artifact. */
function toAssemblyStack(id: string, artifact: StackArtifact): AssemblyStack {
	const region = artifact.environment?.split('/')[3];
	return {
		stackName: artifact.properties?.stackName ?? id,
		region: region && region !== 'unknown-region' ? region : undefined,
	};
}

/**
 * The top-level stacks of the synthesized assembly at `assemblyDir`, by
 * CloudFormation stack name and Region: the stacks `cdk deploy --all` and
 * `cdk destroy --all` select. Unlike `cdk ls`, which prints construct paths
 * (`Parent/Nested`) and also lists stacks inside a CDK `Stage`, these are the
 * names CloudFormation knows, each with its own Region (a Lambda@Edge
 * `edge-lambda-stack-*` is always in us-east-1). [] if the assembly can't be read.
 */
export function topLevelStacks(assemblyDir: string): AssemblyStack[] {
	return readStackArtifacts(assemblyDir).map(([id, artifact]) => toAssemblyStack(id, artifact));
}

/**
 * The stacks in the synthesized assembly at `assemblyDir` whose template
 * contains a resource in {@link EXPRESS_UNSAFE_RESOURCE_TYPES}. Reads
 * `manifest.json` + each stack's template; [] if the assembly can't be read.
 */
export function stacksWithExpressUnsafeResources(assemblyDir: string): AssemblyStack[] {
	const stacks: AssemblyStack[] = [];
	for (const [id, artifact] of readStackArtifacts(assemblyDir)) {
		if (!artifact.properties?.templateFile) continue;
		let template: { Resources?: Record<string, { Type?: string }> };
		try {
			template = JSON.parse(readFileSync(join(assemblyDir, artifact.properties.templateFile), 'utf-8'));
		} catch {
			continue;
		}
		const hasUnsafe = Object.values(template.Resources ?? {}).some((r) => EXPRESS_UNSAFE_RESOURCE_TYPES.has(r.Type ?? ''));
		if (!hasUnsafe) continue;
		stacks.push(toAssemblyStack(id, artifact));
	}
	return stacks;
}

/**
 * The stacks (of `stacks`, each containing a resource Express Mode can't
 * update) that already exist — so this deploy would UPDATE them. Fails closed:
 * any error other than "stack does not exist" (credentials, throttling, access)
 * counts as existing, so a deploy never risks Express Mode's unrecoverable
 * UPDATE_FAILED state on a guess.
 */
export async function findExpressUnsafeStacks(
	stacks: AssemblyStack[],
	cfnFor?: (region: string | undefined) => CloudFormationClient,
): Promise<string[]> {
	if (stacks.length === 0) return [];
	const { CloudFormationClient: Client, DescribeStacksCommand } = await import('@aws-sdk/client-cloudformation');
	const clientFor = cfnFor ?? ((region: string | undefined) => new Client(region ? { region } : {}));
	const unsafe: string[] = [];
	for (const { stackName, region } of stacks) {
		try {
			const res = await clientFor(region).send(new DescribeStacksCommand({ StackName: stackName }));
			const status = res.Stacks?.[0]?.StackStatus;
			if (status && status !== 'DELETE_COMPLETE') unsafe.push(stackName);
		} catch (e) {
			const message = (e as Error).message ?? '';
			if (!/does not exist/i.test(message)) unsafe.push(stackName);
		}
	}
	return unsafe;
}

/** Empty a versioned bucket: delete every object version + delete marker in
 * pages of 1000 (the DeleteObjects limit). Stops if a page reports per-key
 * errors (object-lock / retention) so it can't loop forever. */
export async function emptyBucket(s3: S3Client, bucket: string): Promise<void> {
	const { ListObjectVersionsCommand, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
	while (true) {
		const listed = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1000 }));
		const objects = toDeleteObjects(listed);
		if (objects.length === 0) return;
		const res = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
		if (res.Errors && res.Errors.length > 0) {
			// A bucket we can't fully empty (object-lock / retention / AccessDenied)
			// will keep blocking `cdk destroy`, so the stack won't tear down until it's
			// resolved by hand. Log loudly with the first error code — this is the
			// kind of silent skip that leaks a stack, so make it visible in CI output.
			const first = res.Errors[0];
			log.warn(
				`  ⚠️  ${bucket}: ${res.Errors.length} object(s) could NOT be deleted ` +
					`(e.g. ${first.Key}: ${first.Code}). This bucket will block stack teardown ` +
					`until cleared manually.`,
			);
			return;
		}
	}
}

/** Clients {@link emptySandboxBuckets} uses; injectable for tests. */
export interface EmptyBucketsClients {
	/** CloudFormation client for a Region (`undefined`: the default Region). */
	cfnFor?: (region: string | undefined) => CloudFormationClient;
	s3?: S3Client;
}

/**
 * The AWS clients a destroy's retry uses, aimed at the account and Region CDK
 * destroys in: SDK v3 clients don't read `cdk.json` or `AWS_DEFAULT_PROFILE`
 * (see {@link resolveDeploymentTarget}), so default clients could look in
 * another Region or account and find nothing. A stack pinned to a Region (the
 * us-east-1 Lambda@Edge stack) is still looked up in its own Region.
 */
export async function destroyRetryClients(projectRoot: string): Promise<Required<EmptyBucketsClients>> {
	const target = await resolveDeploymentTarget({ projectRoot });
	const { CloudFormationClient } = await import('@aws-sdk/client-cloudformation');
	const { S3Client } = await import('@aws-sdk/client-s3');
	const region = target.region ?? undefined;
	const cfnByRegion = new Map<string | undefined, CloudFormationClient>();
	return {
		cfnFor: (stackRegion) => {
			const key = stackRegion ?? region;
			let cfn = cfnByRegion.get(key);
			if (!cfn) {
				cfn = new CloudFormationClient({ region: key, profile: target.profile });
				cfnByRegion.set(key, cfn);
			}
			return cfn;
		},
		s3: new S3Client({ region, profile: target.profile, followRegionRedirects: true }),
	};
}

/**
 * Empty every versioned S3 bucket owned by the given stacks. `cdk destroy`
 * relies on each bucket's `autoDeleteObjects` custom-resource Lambda to empty
 * it on teardown — but that Lambda never provisions if the CREATE failed (e.g.
 * a partial/aborted deploy), so the versioned bucket blocks the delete and the
 * stack (and its IAM roles) leak. Emptying out-of-band before the retry lets
 * the delete complete. Best-effort: any per-stack/per-bucket error is logged
 * and skipped so teardown still proceeds. Exported so the production destroy
 * path ({@link ./destroy.ts}) reuses the same bucket-emptying step.
 *
 * Each stack's resources are listed in that stack's own Region (see
 * {@link topLevelStacks}), so a stack outside the default Region, such as a
 * us-east-1 Lambda@Edge `edge-lambda-stack-*`, is not skipped as "not found".
 */
export async function emptySandboxBuckets(stacks: AssemblyStack[], clients: EmptyBucketsClients = {}): Promise<void> {
	try {
		const { CloudFormationClient } = await import('@aws-sdk/client-cloudformation');
		const { S3Client } = await import('@aws-sdk/client-s3');
		const cfnFor = clients.cfnFor ?? ((region: string | undefined) => new CloudFormationClient(region ? { region } : {}));
		const cfnByRegion = new Map<string | undefined, CloudFormationClient>();
		// `followRegionRedirects` makes the client transparently retry against a
		// bucket's real region on a PermanentRedirect, so a bucket that lives
		// outside AWS_REGION (e.g. a us-east-1 Lambda@Edge stack's bucket) is still
		// emptied instead of failing silently — closing the exact no-op this fix
		// targets. It needs no GetBucketLocation permission.
		const s3 = clients.s3 ?? new S3Client({ followRegionRedirects: true });
		for (const { stackName, region } of stacks) {
			let cfn = cfnByRegion.get(region);
			if (!cfn) {
				cfn = cfnFor(region);
				cfnByRegion.set(region, cfn);
			}
			let buckets: string[] = [];
			try {
				buckets = await listStackBucketNames(cfn, stackName);
			} catch {
				continue; // stack already gone / not accessible
			}
			for (const b of buckets) {
				try {
					await emptyBucket(s3, b);
				} catch (e) {
					log.warn(`  ⚠️  could not empty ${b}: ${(e as Error).message}`);
					log.debugError(e);
				}
			}
		}
	} catch (e) {
		log.warn(`  ⚠️  bucket-emptying step skipped: ${(e as Error).message}`);
		log.debugError(e);
	}
}

/**
 * The stacks of the assembly a `cdk destroy --output <assemblyDir>` attempt
 * synthesized (see {@link topLevelStacks}): the set that `--all` deletes, by
 * stack name and Region. Warns when the assembly can't be read (the synth
 * failed), since an empty list skips the bucket-emptying before the retry.
 */
export function listDestroyedStacks(assemblyDir: string): AssemblyStack[] {
	const stacks = topLevelStacks(assemblyDir);
	if (stacks.length === 0) {
		log.warn(
			`  ⚠️  could not read the synthesized stacks in ${assemblyDir}; skipping bucket-emptying and the throttle and ` +
				'Lambda@Edge checks',
		);
	}
	return stacks;
}

/**
 * Whether a CloudFormation resource status reason says an AWS API throttled
 * the call, e.g. `Too Many Requests (Service: ApiGateway, Status Code: 429)`
 * (DeleteRestApi is limited to one request every 30s per account),
 * `Rate exceeded (... Error Code: Throttling)`, EC2 `RequestLimitExceeded` or
 * S3 `SlowDown`. Case-sensitive and matched on the services' error-token
 * shapes, so a resource name that merely contains "throttling" does not match.
 */
export function isThrottleReason(reason: string | undefined): boolean {
	return /\bToo Many Requests\b|\bStatus Code: 429\b|\bTooManyRequestsException\b|\bThrottlingException\b|\bError Code: Throttling\b|\bRate [Ee]xceeded\b|\bRequestLimitExceeded\b|\bError Code: SlowDown\b|\bRequest was throttled\b/.test(
		reason ?? '',
	);
}

/** Clock skew allowed between this machine and CloudFormation event timestamps. */
const EVENT_CLOCK_SKEW_MS = 60_000;
/** DescribeStackEvents pages read per stack before giving up on finding this attempt's start. */
const MAX_EVENT_PAGES = 30;

/**
 * Whether the delete attempt that began at `sinceMs` failed because AWS
 * throttled a resource delete in any of `stacks`. Reads each stack's
 * events newest-first back to this attempt's own stack-level
 * `DELETE_IN_PROGRESS` and counts a throttle only if that start event is found
 * and is no older than `sinceMs` (less clock skew) nor than `notBeforeMs`
 * (the previous attempt's failure, when there was one), so a throttle left
 * over from an earlier attempt is not counted. Stack-level events (the stack's
 * "failed to delete: [ids]" summary, nested stacks) are never read as a
 * throttle. A stack that no longer exists is skipped; any other error (or
 * every stack missing, e.g. stacks in another Region) is thrown after checking
 * the remaining stacks, so the caller can warn and fall back to the ordinary
 * retry schedule.
 *
 * `cfn` is one client for every stack, or a client per Region: then each
 * stack given as an {@link AssemblyStack} is looked up in its own Region (the
 * us-east-1 Lambda@Edge stack of an app deployed elsewhere).
 */
export async function stackDeleteThrottled(
	cfn: CloudFormationClient | ((region: string | undefined) => CloudFormationClient),
	stacks: Array<string | AssemblyStack>,
	sinceMs: number,
	notBeforeMs?: number,
): Promise<boolean> {
	const { DescribeStackEventsCommand } = await import('@aws-sdk/client-cloudformation');
	const oldest = Math.max(sinceMs - EVENT_CLOCK_SKEW_MS, notBeforeMs ?? Number.NEGATIVE_INFINITY);
	const stackNames = stacks.map((st) => (typeof st === 'string' ? st : st.stackName));
	let firstError: unknown;
	let missing = 0;
	for (const stack of stacks) {
		const { stackName, region } = typeof stack === 'string' ? { stackName: stack, region: undefined } : stack;
		const client = typeof cfn === 'function' ? cfn(region) : cfn;
		try {
			let nextToken: string | undefined;
			let sawThrottle = false;
			scan: for (let page = 0; page < MAX_EVENT_PAGES; page++) {
				const res = await client.send(new DescribeStackEventsCommand({ StackName: stackName, NextToken: nextToken }));
				for (const ev of res.StackEvents ?? []) {
					if (ev.Timestamp && ev.Timestamp.getTime() < oldest) break scan;
					if (ev.ResourceType === 'AWS::CloudFormation::Stack') {
						if (ev.LogicalResourceId === stackName && ev.ResourceStatus === 'DELETE_IN_PROGRESS') {
							if (sawThrottle) return true;
							break scan;
						}
						continue;
					}
					if (ev.ResourceStatus === 'DELETE_FAILED' && isThrottleReason(ev.ResourceStatusReason)) sawThrottle = true;
				}
				nextToken = res.NextToken;
				if (!nextToken) break;
			}
		} catch (e) {
			if (/does not exist/i.test((e as Error).message ?? '')) missing++;
			else firstError ??= e;
		}
	}
	if (firstError !== undefined) throw firstError;
	if (stackNames.length > 0 && missing === stackNames.length) {
		throw new Error(`none of the stacks (${stackNames.join(', ')}) were found (already deleted, never deployed, or in another Region)`);
	}
	return false;
}

/**
 * {@link stackDeleteThrottled} with a CloudFormation client per Region: the
 * real `isThrottled` for both destroy paths (`destroySandbox` here and the
 * production `destroy` in `./destroy.ts`). `destroySandbox` passes the clients
 * of {@link destroyRetryClients}; without `cfnFor`, each stack's own Region or
 * else the SDK's default Region and credentials are used.
 */
export async function destroyWasThrottled(
	stacks: AssemblyStack[],
	sinceMs: number,
	notBeforeMs?: number,
	cfnFor?: (region: string | undefined) => CloudFormationClient,
): Promise<boolean> {
	if (stacks.length === 0) return false;
	const { CloudFormationClient } = await import('@aws-sdk/client-cloudformation');
	const clientFor = cfnFor ?? ((region: string | undefined) => new CloudFormationClient(region ? { region } : {}));
	return stackDeleteThrottled(clientFor, stacks, sinceMs, notBeforeMs);
}


const THROTTLE_BACKOFF_DEFAULTS: Required<ThrottleBackoff> = {
	baseMs: 60_000,
	maxDelayMs: 300_000,
	budgetMs: 20 * 60_000,
};

/**
 * The wait before throttle retry number `retry` (0-based): exponential
 * (`baseMs * 2^retry`, capped at `maxDelayMs`) with equal jitter, i.e. a
 * random point in `[step/2, step]`. The jitter spreads parallel destroys in
 * one account apart, so they stop retrying DeleteRestApi in lockstep.
 */
export function throttleBackoffDelay(retry: number, backoff: ThrottleBackoff, random: () => number): number {
	const { baseMs, maxDelayMs } = { ...THROTTLE_BACKOFF_DEFAULTS, ...backoff };
	const step = Math.min(maxDelayMs, baseMs * 2 ** retry);
	return Math.round(step / 2 + random() * (step / 2));
}

/** Whether `stackName` is the us-east-1 stack CDK adds for a Lambda@Edge function (`edge-lambda-stack-*`). */
export function isEdgeLambdaStack(stackName: string): boolean {
	return stackName.startsWith('edge-lambda-stack-');
}

/**
 * The Lambda@Edge stacks (of `stacks`, see {@link isEdgeLambdaStack}) whose
 * delete failed because CloudFront still replicates their function: a
 * resource in `DELETE_FAILED` whose reason says it "is a replicated function",
 * updated no earlier than `sinceMs` (epoch ms, less a minute of clock skew), so
 * a failure left over from an earlier run is not counted. Each stack is looked
 * up in its own Region. A stack that can't be listed (gone, no access,
 * throttled) is not counted, so the caller falls back to its ordinary retries.
 */
export async function edgeStacksBlockedByReplicas(
	stacks: AssemblyStack[],
	sinceMs: number,
	cfnFor?: (region: string | undefined) => CloudFormationClient,
): Promise<string[]> {
	const edgeStacks = stacks.filter((s) => isEdgeLambdaStack(s.stackName));
	if (edgeStacks.length === 0) return [];
	const { CloudFormationClient: Client, ListStackResourcesCommand } = await import('@aws-sdk/client-cloudformation');
	const clientFor = cfnFor ?? ((region: string | undefined) => new Client(region ? { region } : {}));
	const blocked: string[] = [];
	for (const { stackName, region } of edgeStacks) {
		try {
			let token: string | undefined;
			let replicated = false;
			do {
				const res = await clientFor(region).send(new ListStackResourcesCommand({ StackName: stackName, NextToken: token }));
				replicated ||= (res.StackResourceSummaries ?? []).some(
					(r) =>
						r.ResourceStatus === 'DELETE_FAILED' &&
						/replicated function/i.test(r.ResourceStatusReason ?? '') &&
						(r.LastUpdatedTimestamp?.getTime() ?? Number.NEGATIVE_INFINITY) >= sinceMs - EVENT_CLOCK_SKEW_MS,
				);
				token = res.NextToken;
			} while (token && !replicated);
			if (replicated) blocked.push(stackName);
		} catch {
			// Not listable: leave it to the ordinary retries.
		}
	}
	return blocked;
}


/**
 * Retry `cdk destroy`, clearing the two known teardown blockers before each
 * retry: (1) non-empty versioned S3 buckets — `cdk destroy` relies on each
 * bucket's autoDeleteObjects Lambda, which never provisioned if the CREATE
 * failed, so the bucket blocks the delete and the stack (+ its IAM roles) leaks;
 * we empty them out-of-band — and (2) VPC ENIs that take 60-120s to detach (the
 * backoff). Stack names are resolved once and reused (topology is stable across
 * attempts; an empty list, e.g. after a failed synth, is resolved again).
 * Deterministic auth/account failures never reach here: both callers
 * run an {@link assertAwsCredentials} pre-flight first, so this loop only ever
 * retries a transient teardown blocker. Factored out with injectable deps so
 * this behavior is unit-testable.
 *
 * A failure that `isThrottled` attributes to an AWS API throttle (typically
 * API Gateway's DeleteRestApi quota of one request every 30s per account, hit
 * when several stacks in one account tear down at once) is retried longer:
 * jittered exponential backoff ({@link throttleBackoffDelay}) until
 * `throttleBackoff.budgetMs` after the first failure is spent. Every other
 * failure keeps the `retryDelays` schedule: at most `retryDelays.length`
 * ordinary retries per call, whatever throttled retries came between them,
 * and none once a throttle backoff has used up the budget. A failure counts as
 * throttled when any resource delete in that attempt was throttled, so another
 * resource that failed for a different reason in the same attempt gets the
 * throttle schedule too: it is retried later, not hidden, and still fails the
 * call once the budget is spent. With 5-minute attempts a call can run for
 * about 30 minutes before it fails (about 18 with the ordinary schedule alone).
 *
 * A Lambda@Edge function can only be deleted once CloudFront has removed its
 * replicas, which takes a few hours after its distribution is deleted. So when
 * a failed attempt's Lambda@Edge stack failed on its replicated function,
 * retrying within minutes cannot help (CDK would fail on that stack again and
 * stop there): the loop prints that and tells the user to run
 * {@link DestroyRetryDeps.rerunCommand} again later.
 */
export async function runDestroyWithRetries(deps: DestroyRetryDeps): Promise<void> {
	const retryDelays = deps.retryDelays ?? [60_000, 120_000];
	const label = deps.successLabel ?? 'Sandbox';
	const now = deps.now ?? Date.now;
	const random = deps.random ?? Math.random;
	const isThrottled = deps.isThrottled ?? (async () => false);
	const { budgetMs } = { ...THROTTLE_BACKOFF_DEFAULTS, ...deps.throttleBackoff };
	let stacks: AssemblyStack[] | undefined;
	let firstFailureAt: number | undefined;
	let lastFailureAt: number | undefined;
	let throttleRetries = 0;
	let ordinaryRetries = 0;
	for (let attempt = 0; ; attempt++) {
		const attemptStartedAt = now();
		try {
			await deps.runDestroy();
			console.log(attempt === 0 ? `\n✅ ${label} destroyed!` : `\n✅ ${label} destroyed on retry!`);
			return;
		} catch (error) {
			const previousFailureAt = lastFailureAt;
			lastFailureAt = now();
			firstFailureAt ??= lastFailureAt;
			if (!stacks?.length) stacks = deps.listStacks();
			const edgeBlocked = await edgeStacksBlocked(deps, stacks, attemptStartedAt);
			if (edgeBlocked.length > 0) {
				deps.printRetainedOutput?.();
				console.error(
					`\n❌ ${edgeBlocked.join(', ')} can't be deleted yet: CloudFront still holds replicas of its Lambda@Edge ` +
						'function, which take a few hours to clear after the distribution is deleted, so retrying now cannot ' +
						`help. Run \`${deps.rerunCommand ?? 'npm run sandbox:destroy'}\` again later; it also deletes any other ` +
						'stack still left.',
				);
				throw error;
			}
			let throttled = false;
			try {
				throttled = await isThrottled(stacks, attemptStartedAt, previousFailureAt);
			} catch (e) {
				log.warn(
					`  ⚠️  could not tell whether the delete was throttled; using the ordinary retry schedule: ${(e as Error).message}`,
				);
				log.debugError(e);
			}
			let delayMs: number | undefined;
			const throttleBudgetSpent = throttleRetries > 0 && now() - firstFailureAt > budgetMs;
			if (throttled) {
				const next = throttleBackoffDelay(throttleRetries, deps.throttleBackoff ?? {}, random);
				if (now() - firstFailureAt + next <= budgetMs) delayMs = next;
			} else if (ordinaryRetries < retryDelays.length && !throttleBudgetSpent) {
				delayMs = retryDelays[ordinaryRetries];
			}
			if (delayMs === undefined) {
				deps.printRetainedOutput?.();
				console.error('\n❌ Destroy failed after retries.');
				if (throttled) {
					console.error(
						'   The last attempt was throttled by AWS (for example, API Gateway allows one REST API ' +
							'delete every 30s per account). Wait a few minutes and run destroy again; if it fails ' +
							'again, check the stack events for other errors.',
					);
				} else if (ordinaryRetries < retryDelays.length) {
					console.error(
						'   Earlier attempts were throttled by AWS and used up the retry time. Check the stack ' +
							'events for this failure, then run destroy again.',
					);
				}
				throw error;
			}
			if (stacks.length > 0) {
				log.progress('\n🧹 Emptying versioned S3 buckets before retry...');
				await deps.emptyBuckets(stacks);
			}
			const delaySec = Math.round(delayMs / 1000);
			if (throttled) {
				throttleRetries++;
				log.progress(
					`\n⏳ Stack deletion was throttled by AWS (API rate limit). Retrying in ${delaySec}s ` +
						`(throttle retry ${throttleRetries}; backing off for up to ${Math.round(budgetMs / 60_000)} min)...`,
				);
			} else {
				ordinaryRetries++;
				log.progress(`\n⏳ Stack deletion failed. Retrying in ${delaySec}s (waiting for resource cleanup)...`);
			}
			await deps.sleep(delayMs);
		}
	}
}

/** {@link DestroyRetryDeps.edgeReplicaBlocked}, or [] when it is not given, there are no stacks, or it fails. */
async function edgeStacksBlocked(deps: DestroyRetryDeps, stacks: AssemblyStack[], attemptStartedAt: number): Promise<string[]> {
	if (!deps.edgeReplicaBlocked || stacks.length === 0) return [];
	try {
		return await deps.edgeReplicaBlocked(stacks, attemptStartedAt);
	} catch {
		return [];
	}
}

/**
 * The {@link runDestroyWithRetries} dependencies `destroySandbox` runs with.
 * A separate function so a test can pin the wiring (throttle detection, bucket
 * emptying, the Lambda@Edge stop) without spawning cdk. `clients` are the AWS
 * clients the retry uses (see {@link destroyRetryClients}).
 */
export function sandboxDestroyDeps(
  backendPath: string,
  cdkEnv: NodeJS.ProcessEnv,
  clients: Required<EmptyBucketsClients>,
): DestroyRetryDeps {
  const cdkArgs = [
    "exec", "cdk", "--", "destroy",
    // `--all`, like the deploy (see buildSandboxDeployArgs): without it CDK
    // refuses an app with more than one stack (a Lambda@Edge
    // `edge-lambda-stack-*` outside us-east-1, a VPC lookup stack), so the
    // destroy can never succeed. CDK deletes dependent stacks first.
    "--all",
    "--force",
    "--output", SANDBOX_DESTROY_ASSEMBLY_DIR,
    // sandboxMode=true is what makes the app name this sandbox's stacks;
    // without it the app names its production stacks, and `--all --force`
    // would delete those. projectRoot matches the sandbox deploy, so both
    // resolve the same stack names.
    "--context", "sandboxMode=true",
    "--context", `projectRoot=${process.cwd()}`,
    // Single-quote backendPath: CDK re-runs the --app string through a shell,
    // so an unquoted path containing a space would split.
    "--app", `npm exec tsx -- -C cdk '${backendPath}'`,
  ];
  // At BLOCKS_LOG_LEVEL=quiet|normal the CDK stream is condensed and retained;
  // the retry loop prints it once the destroy finally fails.
  const cdkOutput = createCdkOutput({ label: 'cdk destroy', verb: 'destroy' });
  return {
    runDestroy: () => cdkOutput.run('npm', cdkArgs, { env: cdkEnv }),
    printRetainedOutput: () => cdkOutput.printRetained(),
    listStacks: () => listDestroyedStacks(SANDBOX_DESTROY_ASSEMBLY_DIR),
    emptyBuckets: (stacks) => emptySandboxBuckets(stacks, clients),
    isThrottled: (stacks, since, previous) => destroyWasThrottled(stacks, since, previous, clients.cfnFor),
    edgeReplicaBlocked: (stacks, since) => edgeStacksBlockedByReplicas(stacks, since, clients.cfnFor),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
