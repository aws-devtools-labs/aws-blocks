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
 */
export function isRetainedDependencyFailure(report: DestroyAttemptReport): boolean {
	if (report.failed.length === 0) return false;
	if (!report.failed.every((r) => isDependencyReason(r.reason))) return false;
	if (report.retained.some((r) => r.type === 'AWS::EC2::Subnet')) return false;
	return report.retained.some((r) => RETAINED_NETWORK_HOLDER_TYPES.has(r.type));
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
 * Read what the delete attempt that began at `sinceMs` did to each of
 * `stackNames`: its failed and retained resources. Like `stackDeleteThrottled`
 * in `./sandbox.ts`, it reads each stack's events newest-first back to this
 * attempt's own stack-level `DELETE_IN_PROGRESS` (no older than `sinceMs` less
 * clock skew, nor than `notBeforeMs`), and ignores the events when that start
 * is not found. A stack that was deleted is read by its id (found with
 * ListStacks); a stack that does not exist is skipped. Any other error is
 * thrown after checking the remaining stacks.
 */
export async function inspectStackDelete(
	cfn: CloudFormationClient,
	stackNames: string[],
	sinceMs: number,
	notBeforeMs?: number,
): Promise<DestroyAttemptReport> {
	const { DescribeStackEventsCommand } = await import('@aws-sdk/client-cloudformation');
	const oldest = Math.max(sinceMs - CLOCK_SKEW_MS, notBeforeMs ?? Number.NEGATIVE_INFINITY);
	const report: DestroyAttemptReport = { failed: [], retained: [] };
	let firstError: unknown;
	for (const stackName of stackNames) {
		try {
			let stackRef: string | undefined = stackName;
			const failed: StackResourceRef[] = [];
			const retained: StackResourceRef[] = [];
			let nextToken: string | undefined;
			scan: for (let page = 0; page < MAX_PAGES; page++) {
				let res: DescribeStackEventsCommandOutput;
				try {
					res = await cfn.send(new DescribeStackEventsCommand({ StackName: stackRef, NextToken: nextToken }));
				} catch (e) {
					// A stack deleted by this attempt is no longer found by name.
					if (page > 0 || stackRef !== stackName || !/does not exist/i.test((e as Error).message ?? ''))
						throw e;
					stackRef = await findDeletedStackId(cfn, stackName, sinceMs);
					if (!stackRef) break; // no deletion of it since this attempt began
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
			if (!/does not exist/i.test((e as Error).message ?? '')) firstError ??= e;
		}
	}
	if (firstError !== undefined) throw firstError;
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
): Promise<DestroyAttemptReport> {
	if (stackNames.length === 0) return { failed: [], retained: [] };
	const { CloudFormationClient } = await import('@aws-sdk/client-cloudformation');
	return inspectStackDelete(new CloudFormationClient({}), stackNames, sinceMs, notBeforeMs);
}
