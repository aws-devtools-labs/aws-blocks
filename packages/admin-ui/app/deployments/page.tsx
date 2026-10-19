// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useQuery } from '@tanstack/react-query';
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DeploymentRecord, DeploymentStatus, DeploymentsResponse } from '@/contract/v1';
import { apiGet } from '@/lib/api-client';
import { useEnvironment } from '@/components/environment-context';
import { GuidedEmpty } from '@/components/guided-empty';
import { RequestError } from '@/components/request-error';

const STATUS_VARIANT: Record<DeploymentStatus, 'success' | 'destructive' | 'warning' | 'outline'> = {
	SUCCEEDED: 'success',
	FAILED: 'destructive',
	ROLLED_BACK: 'warning',
	IN_PROGRESS: 'warning',
	UNKNOWN: 'outline',
};

const columns: ColumnDef<DeploymentRecord>[] = [
	{
		accessorKey: 'startedAt',
		header: 'Started',
		cell: ({ getValue }) => new Date(getValue<string>()).toLocaleString(),
	},
	{ accessorKey: 'stage', header: 'Stage' },
	{
		accessorKey: 'status',
		header: 'Status',
		cell: ({ getValue }) => {
			const status = getValue<DeploymentStatus>();
			return <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>;
		},
	},
	{
		accessorKey: 'gitSha',
		header: 'Commit',
		cell: ({ getValue }) => getValue<string | undefined>()?.slice(0, 7) ?? '—',
	},
	{
		accessorKey: 'errorSummary',
		header: 'Error',
		cell: ({ getValue }) => getValue<string | undefined>() ?? '',
	},
];

export default function DeploymentsPage() {
	const router = useRouter();
	const { cloudStage, ready } = useEnvironment();
	const { data, isLoading, error } = useQuery({
		queryKey: ['deployments', cloudStage],
		queryFn: () => {
			// Unreachable in local: `enabled` holds this until a deployed stage is
			// selected. The guard narrows `cloudStage` without a cast.
			if (cloudStage === undefined) throw new Error('deployments requested with no stage');
			return apiGet<DeploymentsResponse>(`/api/v1/deployments?stage=${encodeURIComponent(cloudStage)}`);
		},
		enabled: ready && cloudStage !== undefined,
	});
	const deployments = data?.deployments ?? [];

	const table = useReactTable({
		data: deployments,
		columns,
		getCoreRowModel: getCoreRowModel(),
	});

	// A local run is not a deployment (D77): deploy history is written only by
	// `npm run sandbox` / `npm run deploy`, and the CloudFormation backfill needs
	// a stack name local has not got. So this is not-applicable, not an empty
	// history — the "none recorded yet" card below must never speak for local.
	if (cloudStage === undefined) {
		return (
			<div className="space-y-6">
				<h1 className="text-lg font-semibold tracking-tight">Deployments</h1>
				<GuidedEmpty screen={{ kind: 'local-pillar', pillar: 'deployments' }} />
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<h1 className="text-lg font-semibold tracking-tight">Deployments</h1>
			{isLoading && <p className="text-sm text-fg-soft">Loading deployments…</p>}
			<RequestError error={error} what="the deployment history" />
			{/* Gated on `!error`: "none recorded" is a claim about the data, and a
			    failed request is not evidence for it. */}
			{!isLoading && !error && deployments.length === 0 && (
				<GuidedEmpty
					screen={{
						kind: 'nothing-recorded',
						subject: 'deployments',
						stage: cloudStage,
						// The command this used to name is now the button, so the detail
						// keeps only what the button cannot say: that there are TWO
						// sources, so an empty list means both are empty.
						detail: `Deploy history is written to .blocks/deploy-history.jsonl, and deployments made before that file existed are backfilled from CloudFormation stack events. An empty list means neither source has anything for ${cloudStage}.`,
					}}
				/>
			)}
			{deployments.length > 0 && (
				<Card>
					<CardContent className="p-0">
						<Table>
							<TableHeader>
								{table.getHeaderGroups().map((headerGroup) => (
									<TableRow key={headerGroup.id}>
										{headerGroup.headers.map((header) => (
											<TableHead key={header.id}>
												{flexRender(header.column.columnDef.header, header.getContext())}
											</TableHead>
										))}
									</TableRow>
								))}
							</TableHeader>
							<TableBody>
								{table.getRowModel().rows.map((row) => (
									<TableRow
										key={row.id}
										className="cursor-pointer"
										onClick={() => router.push(`/deployments/${encodeURIComponent(row.original.id)}`)}
									>
										{row.getVisibleCells().map((cell) => (
											<TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
										))}
									</TableRow>
								))}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
