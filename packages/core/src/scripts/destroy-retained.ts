// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a stack delete left behind: the resources CloudFormation skipped because
 * their removal policy is Retain (`DELETE_SKIPPED`), and the resources that
 * failed to delete. {@link runDestroyWithRetries} (in `./sandbox.ts`) uses it to
 * stop retrying a delete that cannot succeed while a retained resource still
 * uses the resources it tries to delete, and to tell the user what a successful
 * destroy kept.
 */

import type { CloudFormationClient, DescribeStackEventsCommandOutput } from '@aws-sdk/client-cloudformation';

/** One resource of a stack, as its delete events describe it. */
export interface StackResourceRef {
	stackName: string;
	logicalId: string;
	type: string;
	physicalId?: string;
	/** The `ResourceStatusReason` of a failed delete. */
	reason?: string;
}

/** What one delete attempt did to the app's stacks. */
export interface DestroyAttemptReport {
	/** Resources whose delete failed (`DELETE_FAILED`), excluding stack-level summaries. */
	failed: StackResourceRef[];
	/** Resources CloudFormation kept because of their removal policy (`DELETE_SKIPPED`). */
	retained: StackResourceRef[];
	/**
	 * Stacks whose delete events could not be read: missing by name, with no
	 * id captured before the destroy and no matching deletion in ListStacks.
	 * Absent when every stack was read.
	 */
	unread?: string[];
}

/** Stack name -> stack id, captured while the stacks still exist (see {@link describeStackIds}). */
export type StackIdMap = ReadonlyMap<string, string>;

/**
 * Whether an AWS error says the stack does not exist (CloudFormation's
 * `Stack with id … does not exist`). Shared with `stackDeleteThrottled` in
 * `./sandbox.ts`.
 */
export function isStackMissingError(e: unknown): boolean {
	return /does not exist/i.test((e as Error | undefined)?.message ?? '');
}

/**
 * Whether a CloudFormation delete failure reason says another resource still
 * uses the one being deleted, e.g. EC2's `The subnet 'subnet-…' has
 * dependencies and cannot be deleted`, `resource sg-… has a dependent object`
 * or `Error Code: DependencyViolation`.
 */
export function isDependencyReason(reason: string | undefined): boolean {
	return /has dependencies|has a dependent object|DependencyViolation/.test(reason ?? '');
}

/**
 * Retained resource types that keep network interfaces in their subnets and
 * security groups for as long as they run. While one of these is retained, a
 * subnet or security group it uses cannot be deleted, however long destroy
 * waits.
 *
 * Deliberately conservative: a holder type missing from this list only makes
 * destroy fall back to its ordinary retries (the pre-existing behavior), while
 * a type listed wrongly would stop a destroy that could have succeeded.
 */
export const RETAINED_NETWORK_HOLDER_TYPES: ReadonlySet<string> = new Set([
	'AWS::RDS::DBCluster',
	'AWS::RDS::DBInstance',
	'AWS::EC2::Instance',
	'AWS::EC2::NetworkInterface',
	'AWS::ElastiCache::CacheCluster',
	'AWS::ElastiCache::ReplicationGroup',
	'AWS::EFS::MountTarget',
]);

/** The resource types a retained network holder keeps in use: its subnets and security groups. */
const HELD_NETWORK_TYPES: ReadonlySet<string> = new Set(['AWS::EC2::Subnet', 'AWS::EC2::SecurityGroup']);

/**
 * Whether a failed delete attempt can never succeed on a retry: every resource
 * that failed, failed because something still uses it, and the app retains a
 * resource that holds network interfaces (for example an Aurora cluster under
 * a `retain` removal policy).
 *
 * A subnet that "has dependencies" is ordinary while a Lambda's network
 * interfaces detach, which takes a few minutes and is worth retrying. So the
 * failure only counts as permanent when no retained resource is a subnet: if
 * the retained resource's own subnets are retained too, the failing subnet
 * belongs to some other network and is retried as before.
 *
 * Each failed resource must also be one a retained holder plausibly keeps in
 * use: a subnet or security group, of a type the app does NOT retain. If the
 * app retains a resource of the same type (e.g. bb-data in a customer-provided
 * VPC retains the cluster's security group), the holder's own one is kept, so
 * the failing one belongs to something else (e.g. a VPC Lambda's security
 * group whose network interfaces are still detaching) and is retried.
 *
 * Why a type heuristic and not an EC2 lookup: the robust check is to look up
 * each failed subnet / security group's network interfaces
 * (DescribeNetworkInterfaces) and stop only when an RDS-owned one, and no
 * Lambda one, is still attached. That needs `@aws-sdk/client-ec2`, which
 * `@aws-blocks/core` does not depend on, and no dependency is added for this.
 * The residual case the heuristic cannot tell apart, a Lambda interface
 * detaching from a subnet / security group that a retained cluster also still
 * uses, is permanent anyway: the cluster keeps that resource in use.
 */
export function isRetainedDependencyFailure(report: DestroyAttemptReport): boolean {
	if (report.failed.length === 0) return false;
	if (!report.failed.every((r) => isDependencyReason(r.reason))) return false;
	if (report.retained.some((r) => r.type === 'AWS::EC2::Subnet')) return false;
	if (!report.retained.some((r) => RETAINED_NETWORK_HOLDER_TYPES.has(r.type))) return false;
	return report.failed.every(
		(r) => HELD_NETWORK_TYPES.has(r.type) && !report.retained.some((kept) => kept.type === r.type),
	);
}

/** One line per resource: `stack/logicalId (type) physicalId`. */
function describe(r: StackResourceRef): string {
	return `${r.stackName}/${r.logicalId} (${r.type})${r.physicalId ? ` ${r.physicalId}` : ''}`;
}

/** The message printed when a destroy stops on {@link isRetainedDependencyFailure}. */
export function formatRetainedDependencyFailure(report: DestroyAttemptReport): string {
	return [
		'\n❌ Destroy stopped: some resources are still used by resources this app retains, so a retry cannot delete them.',
		'   Could not delete:',
		...report.failed.map((r) => `     - ${describe(r)}: ${r.reason ?? 'no reason given'}`),
		'   Retained (still running):',
		...report.retained.map((r) => `     - ${describe(r)}`),
		'   To finish, delete the retained resources (for example in the AWS console), then run destroy again.',
	].join('\n');
}

/**
 * Thrown by {@link runDestroyWithRetries} when it stops on a failure a retained
 * resource causes, after printing {@link formatRetainedDependencyFailure}. The
 * destroy commands end on it with a non-zero exit code and nothing more (see
 * {@link endStoppedDestroy}): cdk already streamed its own error during the
 * attempt, and the summary says what to do. `message` is the failed attempt's,
 * so telemetry still classifies it as a destroy failure; the attempt's error
 * is kept as a non-enumerable `cause`.
 */
export class DestroyStoppedError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = 'DestroyStoppedError';
		Object.defineProperty(this, 'cause', { value: cause, enumerable: false, writable: true, configurable: true });
	}
}

/**
 * Run a destroy command, ending a {@link DestroyStoppedError} with
 * `process.exitCode = 1` instead of rethrowing it: its summary is already
 * printed, and the scaffolded destroy scripts would otherwise print the error
 * again with its stack. Every other error is rethrown unchanged.
 */
export async function endStoppedDestroy(run: () => Promise<void>): Promise<void> {
	try {
		await run();
	} catch (e) {
		if (!(e instanceof DestroyStoppedError)) throw e;
		process.exitCode = 1;
	}
}

/** The summary printed after a successful destroy that retained resources. */
export function formatRetainedSummary(retained: StackResourceRef[]): string {
	return [
		`\nℹ️  Kept ${retained.length} resource(s) because of their removal policy:`,
		...retained.map((r) => `   - ${describe(r)}`),
		"   They keep running, and are billed, until you delete them. To have destroy delete a block's data, " +
			"deploy it with removalPolicy: 'destroy' before destroying.",
	].join('\n');
}

/** Add `more` to `into`, skipping resources (by stack + logical id) already there. */
export function mergeResources(into: StackResourceRef[], more: StackResourceRef[]): void {
	for (const r of more) {
		if (!into.some((x) => x.stackName === r.stackName && x.logicalId === r.logicalId)) into.push(r);
	}
}

/** Clock skew allowed between this machine and CloudFormation timestamps. */
const CLOCK_SKEW_MS = 60_000;
/** API pages read per stack before giving up. */
const MAX_PAGES = 30;

/**
 * The id of `stackName`'s most recent deletion that finished after `sinceMs`
 * (less clock skew), or undefined. A deleted stack's events can only be read by
 * its id, not its name.
 */
async function findDeletedStackId(
	cfn: CloudFormationClient,
	stackName: string,
	sinceMs: number,
): Promise<string | undefined> {
	const { ListStacksCommand } = await import('@aws-sdk/client-cloudformation');
	let best: { id: string; at: number } | undefined;
	let nextToken: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const res = await cfn.send(
			new ListStacksCommand({ StackStatusFilter: ['DELETE_COMPLETE'], NextToken: nextToken }),
		);
		for (const s of res.StackSummaries ?? []) {
			const at = s.DeletionTime?.getTime();
			if (s.StackName !== stackName || !s.StackId || at === undefined || at < sinceMs - CLOCK_SKEW_MS) continue;
			if (!best || at > best.at) best = { id: s.StackId, at };
		}
		nextToken = res.NextToken;
		if (!nextToken) break;
	}
	return best?.id;
}

/**
 * The id of each of `stackNames` that exists now. Called before the first
 * destroy attempt, so the success summary can read a deleted stack's events by
 * id instead of searching ListStacks (which pages through every deleted stack
 * in the account and Region). A stack that does not exist is left out; any
 * other error is thrown after checking the remaining stacks.
 */
export async function describeStackIds(cfn: CloudFormationClient, stackNames: string[]): Promise<Map<string, string>> {
	const { DescribeStacksCommand } = await import('@aws-sdk/client-cloudformation');
	const ids = new Map<string, string>();
	let firstError: unknown;
	for (const stackName of stackNames) {
		try {
			const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
			const id = res.Stacks?.[0]?.StackId;
			if (id) ids.set(stackName, id);
		} catch (e) {
			if (!isStackMissingError(e)) firstError ??= e;
		}
	}
	if (firstError !== undefined) throw firstError;
	return ids;
}

/** {@link describeStackIds} with a default-Region CloudFormation client. */
export async function captureStackIds(stackNames: string[]): Promise<StackIdMap> {
	if (stackNames.length === 0) return new Map();
	const { CloudFormationClient } = await import('@aws-sdk/client-cloudformation');
	return describeStackIds(new CloudFormationClient({}), stackNames);
}

/**
 * Read what the delete attempt that began at `sinceMs` did to each of
 * `stackNames`: its failed and retained resources. Like `stackDeleteThrottled`
 * in `./sandbox.ts`, it reads each stack's events newest-first back to this
 * attempt's own stack-level `DELETE_IN_PROGRESS` (no older than `sinceMs` less
 * clock skew, nor than `notBeforeMs`), and ignores the events when that start
 * is not found. A stack that was deleted is read by its id (found with
 * ListStacks); a stack that does not exist is skipped. Any other error is
 * thrown after checking the remaining stacks.
 *
 * A stack in `stackIds` (captured before the destroy) is read by that id
 * directly; ListStacks is only the fallback for a stack with no captured id.
 * A stack found by neither is listed in `unread`. Nested stacks (and nested
 * cloud assemblies) are not followed: only the named stacks' own events are
 * read.
 */
export async function inspectStackDelete(
	cfn: CloudFormationClient,
	stackNames: string[],
	sinceMs: number,
	notBeforeMs?: number,
	stackIds?: StackIdMap,
): Promise<DestroyAttemptReport> {
	const { DescribeStackEventsCommand } = await import('@aws-sdk/client-cloudformation');
	const oldest = Math.max(sinceMs - CLOCK_SKEW_MS, notBeforeMs ?? Number.NEGATIVE_INFINITY);
	const report: DestroyAttemptReport = { failed: [], retained: [] };
	const unread: string[] = [];
	let firstError: unknown;
	for (const stackName of stackNames) {
		try {
			const knownId = stackIds?.get(stackName);
			let stackRef: string | undefined = knownId ?? stackName;
			const failed: StackResourceRef[] = [];
			const retained: StackResourceRef[] = [];
			let nextToken: string | undefined;
			scan: for (let page = 0; page < MAX_PAGES; page++) {
				let res: DescribeStackEventsCommandOutput;
				try {
					res = await cfn.send(new DescribeStackEventsCommand({ StackName: stackRef, NextToken: nextToken }));
				} catch (e) {
					// A stack deleted by this attempt is no longer found by name.
					if (page > 0 || stackRef !== stackName || !isStackMissingError(e)) throw e;
					stackRef = await findDeletedStackId(cfn, stackName, sinceMs);
					if (!stackRef) {
						// No deletion of it since this attempt began.
						unread.push(stackName);
						break;
					}
					res = await cfn.send(new DescribeStackEventsCommand({ StackName: stackRef }));
				}
				for (const ev of res.StackEvents ?? []) {
					if (ev.Timestamp && ev.Timestamp.getTime() < oldest) break scan;
					if (ev.ResourceType === 'AWS::CloudFormation::Stack' && ev.LogicalResourceId === stackName) {
						if (ev.ResourceStatus === 'DELETE_IN_PROGRESS') {
							// This attempt's start: its events are the ones collected so far.
							mergeResources(report.failed, failed);
							mergeResources(report.retained, retained);
							break scan;
						}
						continue;
					}
					const ref: StackResourceRef = {
						stackName,
						logicalId: ev.LogicalResourceId ?? '?',
						type: ev.ResourceType ?? '?',
						physicalId: ev.PhysicalResourceId || undefined,
					};
					// A nested stack's failure is a summary of its own resources, not a cause.
					if (ev.ResourceStatus === 'DELETE_FAILED' && ev.ResourceType !== 'AWS::CloudFormation::Stack') {
						failed.push({ ...ref, reason: ev.ResourceStatusReason });
					} else if (ev.ResourceStatus === 'DELETE_SKIPPED') {
						retained.push(ref);
					}
				}
				nextToken = res.NextToken;
				if (!nextToken) break;
			}
		} catch (e) {
			if (!isStackMissingError(e)) firstError ??= e;
			else unread.push(stackName);
		}
	}
	if (firstError !== undefined) throw firstError;
	if (unread.length > 0) report.unread = unread;
	return report;
}

/**
 * {@link inspectStackDelete} with a default-Region CloudFormation client: the
 * real `inspectAttempt` for both destroy paths.
 */
export async function inspectDestroyAttempt(
	stackNames: string[],
	sinceMs: number,
	notBeforeMs?: number,
	stackIds?: StackIdMap,
): Promise<DestroyAttemptReport> {
	if (stackNames.length === 0) return { failed: [], retained: [] };
	const { CloudFormationClient } = await import('@aws-sdk/client-cloudformation');
	return inspectStackDelete(new CloudFormationClient({}), stackNames, sinceMs, notBeforeMs, stackIds);
}
