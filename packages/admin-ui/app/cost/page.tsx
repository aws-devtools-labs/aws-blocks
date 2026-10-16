// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { CostResponse } from '@/contract/v1';
import { apiGet } from '@/lib/api-client';
import { useEnvironment } from '@/components/environment-context';
import { GuidedEmpty } from '@/components/guided-empty';
import { RequestError } from '@/components/request-error';

function money(amount: number | undefined, currency = 'USD'): string {
	if (amount === undefined) return '—';
	return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

const ATTRIBUTION_COPY: Record<
	NonNullable<CostResponse['attribution']>,
	{ label: string; variant: 'success' | 'warning' | 'destructive'; blurb: (r: CostResponse) => string }
> = {
	'stack-tag': {
		label: 'this stack',
		variant: 'success',
		blurb: (r) => `Filtered by the aws:cloudformation:stack-name cost allocation tag — exactly ${r.stackName}.`,
	},
	'deployment-type-tag': {
		label: `Blocks deployments`,
		variant: 'warning',
		blurb: (r) =>
			`Filtered by blocks:deployment-type=${r.stage} — ALL Blocks ${r.stage} deployments in this account, not just this app. Activate the aws:cloudformation:stack-name cost allocation tag for exact per-stack attribution.`,
	},
	'account-unattributed': {
		label: 'whole account',
		variant: 'destructive',
		blurb: () =>
			'No usable cost allocation tag is active — these are WHOLE-ACCOUNT totals. Activate aws:cloudformation:stack-name (best) or blocks:deployment-type in the billing console (Billing → Cost allocation tags; needs billing permissions, backfills within ~24h).',
	},
};

export default function CostPage() {
	const { cloudStage, ready } = useEnvironment();

	const { data, isLoading, error } = useQuery({
		queryKey: ['cost', cloudStage],
		queryFn: () => {
			// Unreachable in local: `enabled` holds this until a deployed stage is
			// selected. The guard narrows `cloudStage` without a cast.
			if (cloudStage === undefined) throw new Error('cost requested with no stage');
			return apiGet<CostResponse>(`/api/v1/cost?stage=${encodeURIComponent(cloudStage)}`);
		},
		// Never poll: each uncached request costs ~$0.01 in Cost Explorer fees.
		refetchOnWindowFocus: false,
		staleTime: 15 * 60_000,
		enabled: ready && cloudStage !== undefined,
	});

	const maxDay = Math.max(...(data?.days.map((d) => d.amount) ?? [0]), 0.01);
	const attribution = data?.attribution ? ATTRIBUTION_COPY[data.attribution] : undefined;

	// Running locally is not billed (D78), so there is no spend to attribute and a
	// Cost Explorer GetCostAndUsage is never issued for local — firing one whose
	// answer is known in advance would spend ~$0.01 to obtain a failure.
	if (cloudStage === undefined) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-4">
					<h1 className="text-lg font-semibold tracking-tight">Cost</h1>
				</div>
				<GuidedEmpty screen={{ kind: 'local-pillar', pillar: 'cost' }} />
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-4">
				<h1 className="text-lg font-semibold tracking-tight">Cost</h1>
				{data?.fetchedAt && (
					<span className="ml-auto text-xs text-fg-dim">
						cached {new Date(data.fetchedAt).toLocaleTimeString()} · Cost Explorer bills ~$0.01/request
					</span>
				)}
			</div>

			{isLoading && <p className="text-sm text-fg-soft">Loading cost data…</p>}
			<RequestError error={error} what="cost data" />

			{data?.costSource === 'unavailable' &&
				(data.costErrorCode === 'ACCESS_DENIED' ? (
					<GuidedEmpty
						screen={{
							kind: 'access-denied',
							permission: 'ce:GetCostAndUsage and ce:ListCostAllocationTags',
							// The second cause, which no permission fixes, so it belongs in
							// the detail rather than in the next step.
							detail: `${data.costError} Cost Explorer also has to be enabled once per account, in the Billing console under Cost Explorer.`,
						}}
					/>
				) : (
					<Card>
						<CardHeader>
							<CardTitle className="text-base">
								{data.costErrorCode === 'CREDENTIALS_EXPIRED' ? 'AWS credentials expired' : 'Cost data unavailable'}
							</CardTitle>
							<CardDescription>{data.costError}</CardDescription>
						</CardHeader>
					</Card>
				))}

			{data?.costSource === 'cost-explorer' && attribution && (
				<>
					<Card className={data.attribution === 'account-unattributed' ? 'border-warn/30' : ''}>
						<CardContent className="flex items-start gap-3 pt-6 text-sm">
							<Badge variant={attribution.variant}>attribution: {attribution.label}</Badge>
							<p className="text-fg-soft">{attribution.blurb(data)}</p>
						</CardContent>
					</Card>

					<div className="grid gap-6 md:grid-cols-3">
						<Card>
							<CardHeader>
								<CardDescription>Last 30 days{data.attribution === 'account-unattributed' ? ' (account)' : ''}</CardDescription>
								<CardTitle className="text-3xl">{money(data.total, data.currency)}</CardTitle>
							</CardHeader>
						</Card>
						<Card className="md:col-span-2">
							<CardHeader className="pb-2">
								<CardDescription>Daily</CardDescription>
							</CardHeader>
							<CardContent>
								<div className="flex h-24 items-end gap-[2px]">
									{data.days.map((day) => (
										<div
											key={day.date}
											title={`${day.date}: ${money(day.amount, data.currency)}`}
											className="flex-1 rounded-t-sm bg-brand/70 transition-colors hover:bg-brand"
											style={{ height: `${Math.max((day.amount / maxDay) * 100, 2)}%` }}
										/>
									))}
								</div>
								<div className="mt-1 flex justify-between text-xs text-fg-dim">
									<span>{data.days[0]?.date}</span>
									<span>{data.days[data.days.length - 1]?.date}</span>
								</div>
							</CardContent>
						</Card>
					</div>

					<Card>
						<CardHeader>
							<CardTitle className="text-base">By service</CardTitle>
						</CardHeader>
						<CardContent className="p-0">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Service</TableHead>
										<TableHead className="text-right">30-day cost</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.byService.length === 0 && (
										<TableRow>
											<TableCell colSpan={2} className="text-fg-soft">
												No costs recorded in this period{data.attribution !== 'account-unattributed' ? ' for this attribution filter — tag backfill takes ~24h after activation' : ''}.
											</TableCell>
										</TableRow>
									)}
									{data.byService.map((row) => (
										<TableRow key={row.service}>
											<TableCell>{row.service}</TableCell>
											<TableCell className="text-right font-mono text-xs">{money(row.amount, data.currency)}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				</>
			)}
		</div>
	);
}
