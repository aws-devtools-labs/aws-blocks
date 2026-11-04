// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { LogGroupInfo } from '../contract/v1.js';
import { awsClientConfig } from './aws-config.js';

/**
 * Log group discovery (M2): a Blocks app's log groups are derivable from
 * its CloudFormation stack resources — no naming conventions, no guessing:
 *
 * - AWS::Logs::LogGroup resources ARE log groups (PhysicalResourceId = name)
 * - AWS::Lambda::Function resources log implicitly to /aws/lambda/<fnName>
 *
 * Explicit groups win on name collisions (a stack may declare the log group
 * for its own Lambda — same group, richer resource identity).
 */

/** Raw shape from CloudFormation ListStackResources. */
export interface RawStackResource {
	LogicalResourceId?: string;
	PhysicalResourceId?: string;
	ResourceType?: string;
}

/** Pure mapping: stack resources → log groups, explicit-first, name-deduped. */
export function resourcesToLogGroups(resources: RawStackResource[]): LogGroupInfo[] {
	const byName = new Map<string, LogGroupInfo>();

	const add = (group: LogGroupInfo) => {
		const existing = byName.get(group.name);
		if (!existing || (existing.source === 'lambda' && group.source === 'explicit')) {
			byName.set(group.name, group);
		}
	};

	for (const resource of resources) {
		if (!resource.PhysicalResourceId || !resource.LogicalResourceId) continue;
		if (resource.ResourceType === 'AWS::Logs::LogGroup') {
			add({
				name: resource.PhysicalResourceId,
				source: 'explicit',
				logicalResourceId: resource.LogicalResourceId,
				resourceType: resource.ResourceType,
			});
		} else if (resource.ResourceType === 'AWS::Lambda::Function') {
			add({
				name: `/aws/lambda/${resource.PhysicalResourceId}`,
				source: 'lambda',
				logicalResourceId: resource.LogicalResourceId,
				resourceType: resource.ResourceType,
			});
		}
	}

	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Fetches all stack resources (paginated) via the AWS SDK. Throws on any AWS error. */
export async function fetchStackResources(stackName: string, region?: string): Promise<RawStackResource[]> {
	const { CloudFormationClient, paginateListStackResources } = await import('@aws-sdk/client-cloudformation');
	const client = new CloudFormationClient(awsClientConfig(region));
	const resources: RawStackResource[] = [];
	const paginator = paginateListStackResources({ client }, { StackName: stackName });
	for await (const page of paginator) {
		resources.push(...(page.StackResourceSummaries ?? []));
	}
	return resources;
}

/** Enrichment fields from CloudWatch Logs DescribeLogGroups. */
export interface LogGroupMetadata {
	/** null = group exists with no retention policy (never expires). */
	retentionDays: number | null;
	storedBytes?: number;
}

/**
 * Enriches groups with retention/size via DescribeLogGroups, exact-name
 * matched. Best-effort: enrichment failure must not break discovery (the
 * group list is the product; metadata is decoration).
 */
export async function fetchLogGroupMetadata(names: string[], region?: string): Promise<Map<string, LogGroupMetadata>> {
	const metadata = new Map<string, LogGroupMetadata>();
	if (names.length === 0) return metadata;
	try {
		const { CloudWatchLogsClient, DescribeLogGroupsCommand } = await import('@aws-sdk/client-cloudwatch-logs');
		const client = new CloudWatchLogsClient(awsClientConfig(region));
		// One exact-prefix query per group, small concurrency; typical Blocks
		// apps have well under 20 groups.
		const CONCURRENCY = 5;
		const queue = [...names];
		const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
			for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
				try {
					const result = await client.send(
						new DescribeLogGroupsCommand({ logGroupNamePrefix: name, limit: 1 }),
					);
					const match = result.logGroups?.find((g) => g.logGroupName === name);
					if (match) {
						metadata.set(name, {
							retentionDays: match.retentionInDays ?? null,
							...(match.storedBytes !== undefined ? { storedBytes: match.storedBytes } : {}),
						});
					}
				} catch {
					// Per-group enrichment failure: skip, keep discovering.
				}
			}
		});
		await Promise.all(workers);
	} catch {
		// SDK load/client failure: no enrichment at all, discovery still valid.
	}
	return metadata;
}
