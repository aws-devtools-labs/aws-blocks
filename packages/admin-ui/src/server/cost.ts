// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CostDay, CostService } from '../contract/v1.js';
import { awsClientConfig } from './aws-config.js';

/**
 * Cost view (M4): Cost Explorer with an ATTRIBUTION LADDER, because cost
 * allocation tags are an account-level opt-in (billing console, billing
 * permissions, ~24h backfill) that most dev accounts never did:
 *
 * 1. aws:cloudformation:stack-name active → filter to exactly this stack
 * 2. blocks:deployment-type active → all Blocks deploys of this stage
 * 3. neither → whole-account totals, labeled unattributed
 *
 * Cost Explorer bills ~$0.01 PER REQUEST — results must be cached by the
 * caller and refreshes must be explicit, never polled.
 */

export const STACK_NAME_TAG = 'aws:cloudformation:stack-name';
export const DEPLOYMENT_TYPE_TAG = 'blocks:deployment-type';
const COST_PERIOD_DAYS = 30;

export interface TagActivation {
	stackNameTagActive: boolean;
	deploymentTypeTagActive: boolean;
}

/** Raw shape we consume from ListCostAllocationTags. */
export interface RawCostAllocationTag {
	TagKey?: string;
	Status?: string;
}

export function evaluateTagActivation(tags: RawCostAllocationTag[]): TagActivation {
	const isActive = (key: string) => tags.some((t) => t.TagKey === key && t.Status === 'Active');
	return {
		stackNameTagActive: isActive(STACK_NAME_TAG),
		deploymentTypeTagActive: isActive(DEPLOYMENT_TYPE_TAG),
	};
}

export interface CostQuery {
	/** Tag filter, or undefined for whole-account totals. */
	filter?: { tagKey: string; tagValue: string };
	attribution: 'stack-tag' | 'deployment-type-tag' | 'account-unattributed';
	/** ISO dates for the CE TimePeriod (Start inclusive, End exclusive). */
	start: string;
	end: string;
}

/** Picks the best attribution the activated tags allow (pure). */
export function buildCostQuery(
	activation: TagActivation,
	stage: string,
	stackName: string | undefined,
	now = new Date(),
): CostQuery {
	const end = now.toISOString().slice(0, 10);
	const start = new Date(now.getTime() - COST_PERIOD_DAYS * 86_400_000).toISOString().slice(0, 10);
	if (activation.stackNameTagActive && stackName) {
		return { filter: { tagKey: STACK_NAME_TAG, tagValue: stackName }, attribution: 'stack-tag', start, end };
	}
	if (activation.deploymentTypeTagActive) {
		return {
			filter: { tagKey: DEPLOYMENT_TYPE_TAG, tagValue: stage },
			attribution: 'deployment-type-tag',
			start,
			end,
		};
	}
	return { attribution: 'account-unattributed', start, end };
}

/** Raw shape we consume from GetCostAndUsage ResultsByTime. */
export interface RawCostResult {
	TimePeriod?: { Start?: string };
	Groups?: Array<{ Keys?: string[]; Metrics?: Record<string, { Amount?: string; Unit?: string }> }>;
	Total?: Record<string, { Amount?: string; Unit?: string }>;
}

export interface MappedCosts {
	days: CostDay[];
	byService: CostService[];
	total: number;
	currency?: string;
}

/** Maps grouped-by-service daily results to the response shape (pure). */
export function mapCostResults(results: RawCostResult[]): MappedCosts {
	const days: CostDay[] = [];
	const serviceTotals = new Map<string, number>();
	let currency: string | undefined;

	for (const result of results) {
		let dayAmount = 0;
		for (const group of result.Groups ?? []) {
			const metric = group.Metrics?.UnblendedCost;
			const amount = Number(metric?.Amount ?? 0);
			if (Number.isNaN(amount)) continue;
			currency ??= metric?.Unit;
			dayAmount += amount;
			const service = group.Keys?.[0] ?? '(unknown)';
			serviceTotals.set(service, (serviceTotals.get(service) ?? 0) + amount);
		}
		// Ungrouped responses carry Total instead of Groups.
		if ((result.Groups ?? []).length === 0 && result.Total?.UnblendedCost) {
			const amount = Number(result.Total.UnblendedCost.Amount ?? 0);
			if (!Number.isNaN(amount)) {
				dayAmount += amount;
				currency ??= result.Total.UnblendedCost.Unit;
			}
		}
		if (result.TimePeriod?.Start) {
			days.push({ date: result.TimePeriod.Start, amount: round2(dayAmount) });
		}
	}

	const byService = [...serviceTotals.entries()]
		.map(([service, amount]) => ({ service, amount: round2(amount) }))
		.filter((s) => s.amount > 0)
		.sort((a, b) => b.amount - a.amount);

	return {
		days,
		byService,
		total: round2(days.reduce((sum, d) => sum + d.amount, 0)),
		currency,
	};
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

/** Fetches cost allocation tag states. Throws on AWS errors. */
export async function fetchCostAllocationTags(): Promise<RawCostAllocationTag[]> {
	const { CostExplorerClient, ListCostAllocationTagsCommand } = await import('@aws-sdk/client-cost-explorer');
	// Cost Explorer is a global API served from us-east-1, so the region stays
	// pinned; awsClientConfig still supplies the configured profile's credentials.
	const client = new CostExplorerClient(awsClientConfig('us-east-1'));
	const result = await client.send(new ListCostAllocationTagsCommand({}));
	return result.CostAllocationTags ?? [];
}

/** Runs the GetCostAndUsage query (daily, grouped by service). Throws on AWS errors. */
export async function fetchCostAndUsage(query: CostQuery): Promise<RawCostResult[]> {
	const { CostExplorerClient, GetCostAndUsageCommand } = await import('@aws-sdk/client-cost-explorer');
	// Cost Explorer is a global API served from us-east-1; see fetchCostAllocationTags.
	const client = new CostExplorerClient(awsClientConfig('us-east-1'));
	const result = await client.send(
		new GetCostAndUsageCommand({
			TimePeriod: { Start: query.start, End: query.end },
			Granularity: 'DAILY',
			Metrics: ['UnblendedCost'],
			GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
			...(query.filter
				? { Filter: { Tags: { Key: query.filter.tagKey, Values: [query.filter.tagValue] } } }
				: {}),
		}),
	);
	return result.ResultsByTime ?? [];
}
