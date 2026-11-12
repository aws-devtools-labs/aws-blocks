// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DeploymentRecord, FailureEvent } from '../contract/v1.js';
import { awsClientConfig } from './aws-config.js';

/**
 * CloudFormation failure-event analysis for the deployment drill-down.
 *
 * The <2min root-cause promise rests on this: instead of scrolling raw
 * CloudWatch/CFN consoles, we fetch the stack events for the deploy window,
 * keep only failures, mark cascade noise (cancellations), and point at the
 * FIRST real failure — CloudFormation cancels siblings and rolls back
 * because of it, so the earliest non-cancelled failure is the root cause.
 */

/** Raw shape of a stack event as returned by DescribeStackEvents. */
export interface RawStackEvent {
	Timestamp?: Date;
	LogicalResourceId?: string;
	ResourceType?: string;
	ResourceStatus?: string;
	ResourceStatusReason?: string;
}

const FAILURE_STATUSES = new Set([
	'CREATE_FAILED',
	'UPDATE_FAILED',
	'DELETE_FAILED',
	'IMPORT_FAILED',
	'IMPORT_ROLLBACK_FAILED',
	'UPDATE_ROLLBACK_FAILED',
	'ROLLBACK_FAILED',
]);

const CANCELLED_REASON_PATTERN = /cancell?ed/i;

/** Reasons that restate "something else failed" rather than naming a cause. */
function isCancellation(event: RawStackEvent): boolean {
	return CANCELLED_REASON_PATTERN.test(event.ResourceStatusReason ?? '');
}

/**
 * Filters raw stack events down to failure events inside the deploy window,
 * mapped to the API shape, newest first.
 */
export function filterFailureEvents(events: RawStackEvent[], window: { from: string; to?: string }): FailureEvent[] {
	const fromMs = Date.parse(window.from);
	// Grace period past finishedAt: rollback events trail the recorded end.
	const toMs = window.to ? Date.parse(window.to) + 5 * 60_000 : Number.POSITIVE_INFINITY;

	return events
		.filter((e) => {
			if (!e.Timestamp || !e.ResourceStatus) return false;
			const t = e.Timestamp.getTime();
			return t >= fromMs && t <= toMs && FAILURE_STATUSES.has(e.ResourceStatus);
		})
		.map((e) => ({
			timestamp: (e.Timestamp as Date).toISOString(),
			logicalResourceId: e.LogicalResourceId ?? '(unknown)',
			resourceType: e.ResourceType ?? '(unknown)',
			resourceStatus: e.ResourceStatus as string,
			statusReason: e.ResourceStatusReason,
			cancelled: isCancellation(e),
		}))
		.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

/**
 * The most likely root cause: the EARLIEST non-cancelled failure event.
 * Cancellations are cascade noise; later failures are usually consequences.
 */
export function pickRootCause(failureEvents: FailureEvent[]): FailureEvent | undefined {
	const real = failureEvents.filter((e) => !e.cancelled);
	if (real.length === 0) return failureEvents.length > 0 ? failureEvents[failureEvents.length - 1] : undefined;
	return real[real.length - 1]; // list is newest-first → last is earliest
}

/** Fetches all stack events (paginated) via the AWS SDK. Throws on any AWS error. */
export async function fetchStackEvents(stackName: string, region?: string): Promise<RawStackEvent[]> {
	// Dynamic import: the SDK only loads when a drill-down actually happens.
	const { CloudFormationClient, paginateDescribeStackEvents } = await import('@aws-sdk/client-cloudformation');
	// region from the deploy record wins; otherwise the ambient SDK chain.
	const client = new CloudFormationClient(awsClientConfig(region));
	const events: RawStackEvent[] = [];
	const paginator = paginateDescribeStackEvents({ client }, { StackName: stackName });
	for await (const page of paginator) {
		events.push(...(page.StackEvents ?? []));
		// Events come newest-first; 500 is plenty for one deploy window.
		if (events.length >= 500) break;
	}
	return events;
}

export type EventsErrorCode = 'CREDENTIALS_EXPIRED' | 'CREDENTIALS_MISSING' | 'STACK_NOT_FOUND' | 'UNKNOWN';

/**
 * Classifies an events-fetch failure so the UI can render targeted help
 * (refresh-credentials hint, region-mismatch hint) instead of a raw
 * SDK message. Matches on error name AND message: SDK error names vary
 * across providers (ExpiredToken, ExpiredTokenException, CredentialsProviderError).
 */
export function classifyEventsError(error: unknown): EventsErrorCode {
	const name = error instanceof Error ? error.name : '';
	const message = error instanceof Error ? error.message : String(error);
	const haystack = `${name} ${message}`;

	if (/ExpiredToken|token.*(is )?expired|expired.*token/i.test(haystack)) return 'CREDENTIALS_EXPIRED';
	if (/CredentialsProviderError|Could not load credentials|Unable to locate credentials|credential/i.test(haystack)) {
		return 'CREDENTIALS_MISSING';
	}
	if (/does not exist|StackNotFound/i.test(haystack)) return 'STACK_NOT_FOUND';
	return 'UNKNOWN';
}

/** Stack-level terminal statuses → deployment status. */
const EPISODE_TERMINAL_STATUS: Record<string, DeploymentRecord['status']> = {
	CREATE_COMPLETE: 'SUCCEEDED',
	UPDATE_COMPLETE: 'SUCCEEDED',
	IMPORT_COMPLETE: 'SUCCEEDED',
	CREATE_FAILED: 'FAILED',
	UPDATE_FAILED: 'FAILED',
	ROLLBACK_FAILED: 'FAILED',
	UPDATE_ROLLBACK_FAILED: 'FAILED',
	IMPORT_ROLLBACK_FAILED: 'FAILED',
	ROLLBACK_COMPLETE: 'ROLLED_BACK',
	UPDATE_ROLLBACK_COMPLETE: 'ROLLED_BACK',
	IMPORT_ROLLBACK_COMPLETE: 'ROLLED_BACK',
	DELETE_COMPLETE: 'UNKNOWN',
	DELETE_FAILED: 'FAILED',
};

const EPISODE_START_STATUSES = new Set(['CREATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS', 'IMPORT_IN_PROGRESS']);

/**
 * BACKFILL (heuristic): reconstructs deployment episodes from stack-level
 * CloudFormation events, for deploys made before deploy-history.jsonl
 * existed. CFN events carry no deploy correlation id — the JSONL written by
 * deploy/sandbox scripts is the primary source, this is only a fallback.
 *
 * An episode starts at a stack-level *_IN_PROGRESS event (a new CFN
 * operation) and ends at the next stack-level terminal status. Rollback
 * phases between the two stay inside the same episode.
 */
export function reconstructDeployments(events: RawStackEvent[], stackName: string, stage: string): DeploymentRecord[] {
	// Stack-level events only, oldest → newest.
	const stackEvents = events
		.filter(
			(e) => e.ResourceType === 'AWS::CloudFormation::Stack' && e.LogicalResourceId === stackName && e.Timestamp,
		)
		.sort((a, b) => ((a.Timestamp as Date) < (b.Timestamp as Date) ? -1 : 1));

	const episodes: DeploymentRecord[] = [];
	let open: DeploymentRecord | undefined;

	for (const event of stackEvents) {
		const status = event.ResourceStatus ?? '';
		const timestamp = (event.Timestamp as Date).toISOString();

		if (EPISODE_START_STATUSES.has(status) && !open) {
			open = {
				id: `cfn-${stackName}-${timestamp}`,
				stage,
				startedAt: timestamp,
				status: 'IN_PROGRESS',
				source: 'cloudformation-events',
			};
			continue;
		}

		const terminal = EPISODE_TERMINAL_STATUS[status];
		if (terminal && open) {
			open.status = terminal;
			open.finishedAt = timestamp;
			if (terminal === 'FAILED' || terminal === 'ROLLED_BACK') {
				open.errorSummary = event.ResourceStatusReason;
			}
			episodes.push(open);
			open = undefined;
		}
	}

	// A trailing open episode is a deploy still running (or events truncated).
	if (open) episodes.push(open);

	// Newest first, matching listDeployments ordering.
	return episodes.reverse();
}
