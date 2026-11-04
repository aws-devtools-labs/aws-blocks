// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import type { ResourceInfo } from '@/contract/v1';

/**
 * The deployed CloudFormation resources of one group.
 *
 * Extracted from the Resources page unchanged, because the block detail page now
 * shows the same table for the block's own group. Two views rendering AWS state
 * from two copies of this markup is how they come to disagree about what a
 * status badge means or which link a resource gets.
 */

export function resourceStatusVariant(status?: string): 'success' | 'destructive' | 'warning' | 'outline' {
	if (!status) return 'outline';
	if (status.endsWith('FAILED')) return 'destructive';
	if (status.includes('ROLLBACK') || status.endsWith('IN_PROGRESS')) return 'warning';
	return 'success';
}

/**
 * The caveat that has to travel with the links.
 *
 * A console link opens in whatever account the reader's browser is signed into,
 * which may not be the account holding this stack — and a `Stack` link lands on
 * the stack's Resources tab rather than the resource itself. Both are properties
 * of the links, not of the page they happen to be on, so this note ships with
 * them rather than being restated wherever a table appears.
 */
export function ConsoleLinkNote({ region }: { region?: string }) {
	return (
		<p className="text-xs text-fg-dim">
			Console links open in whichever AWS account your browser is currently signed into — which may not be the
			account this stack lives in
			{region ? (
				<>
					{' ('}
					<code className="font-mono">{region}</code>
					{')'}
				</>
			) : null}
			. A <span className="text-fg-soft">Stack</span> link lands on the stack’s Resources tab rather than the
			resource itself, because that type has no useful console page of its own.
		</p>
	);
}

export function ResourceTable({ resources }: { resources: ResourceInfo[] }) {
	return (
		/*
		 * `table-fixed` with explicit column widths, because the merge put this
		 * table in a much narrower column: at ~710px it measured 992px wide, of
		 * which the physical id alone took 432px, so Status and Open sat outside the
		 * scroll viewport. Nothing was lost — the wrapper scrolls — but with no
		 * visible scrollbar those two columns simply looked absent.
		 *
		 * Fixed proportions keep all five visible at any width and put the
		 * truncation where it costs least: a physical id is long and opaque, and its
		 * full value is on the cell's `title` and behind the console link. Hiding a
		 * column or dropping one would trade real information for the appearance of
		 * fitting.
		 */
		<Table className="table-fixed">
			<colgroup>
				<col className="w-[21%]" />
				<col className="w-[22%]" />
				<col className="w-[27%]" />
				{/* Wide enough for the longest real status, `UPDATE_ROLLBACK_COMPLETE`
				    being the outlier; at 17% `CREATE_COMPLETE` itself was clipped. */}
				<col className="w-[21%]" />
				<col className="w-[9%]" />
			</colgroup>
			<TableHeader>
				<TableRow>
					<TableHead scope="col">Type</TableHead>
					<TableHead scope="col">Logical id</TableHead>
					<TableHead scope="col">Physical id</TableHead>
					<TableHead scope="col">Status</TableHead>
					<TableHead scope="col">Open</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{resources.map((resource) => (
					<TableRow key={resource.logicalResourceId}>
						<TableCell
							className="truncate font-mono text-xs"
							title={resource.typeLabel ? resource.resourceType : undefined}
						>
							{resource.typeLabel ?? resource.resourceType}
						</TableCell>
						<TableCell className="truncate font-mono text-xs text-fg-soft" title={resource.logicalResourceId}>
							{resource.logicalResourceId}
						</TableCell>
						<TableCell className="truncate font-mono text-xs" title={resource.physicalResourceId}>
							{resource.physicalResourceId ?? '—'}
						</TableCell>
						<TableCell className="truncate">
							{resource.resourceStatus && (
								<Badge variant={resourceStatusVariant(resource.resourceStatus)}>{resource.resourceStatus}</Badge>
							)}
						</TableCell>
						<TableCell className="whitespace-nowrap text-xs">
							{resource.consoleUrl ? (
								<a
									href={resource.consoleUrl}
									target="_blank"
									rel="noopener noreferrer"
									title={
										resource.directLink === true
											? 'Opens this resource directly in the AWS console.'
											: 'No direct console page for this resource type — opens the stack’s Resources tab in the AWS console, where you can find it in the list.'
									}
									className="text-fg-soft hover:text-fg hover:underline"
								>
									{resource.directLink === true ? 'Console' : 'Stack'} ↗
								</a>
							) : (
								<span className="text-fg-dim">—</span>
							)}
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
