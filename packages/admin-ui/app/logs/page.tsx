// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LiveTailPanel } from '@/components/live-tail-panel';
import type { LogGroupsResponse, LogSearchResponse } from '@/contract/v1';
import { apiGet } from '@/lib/api-client';
import { useEnvironment } from '@/components/environment-context';
import { GuidedEmpty } from '@/components/guided-empty';
import { RequestError } from '@/components/request-error';

const LEVEL_VARIANT: Record<string, 'destructive' | 'warning' | 'outline'> = {
	error: 'destructive',
	warn: 'warning',
};

const TIME_RANGES = [
	{ label: '15m', minutes: 15 },
	{ label: '1h', minutes: 60 },
	{ label: '24h', minutes: 24 * 60 },
	{ label: '7d', minutes: 7 * 24 * 60 },
];

function formatBytes(bytes?: number): string {
	if (bytes === undefined) return '—';
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = '';
	for (const u of units) {
		value /= 1024;
		unit = u;
		if (value < 1024) break;
	}
	return `${value.toFixed(1)} ${unit}`;
}

export default function LogsPage() {
	const { cloudStage, ready } = useEnvironment();
	const [text, setText] = useState('');
	const [level, setLevel] = useState('');
	const [logger, setLogger] = useState('');
	const [traceId, setTraceId] = useState('');
	const [rangeMinutes, setRangeMinutes] = useState(60);
	const [selectedGroup, setSelectedGroup] = useState('');
	// The params actually submitted — search runs on demand, not per keystroke
	// (every query scans log data and costs money).
	const [submitted, setSubmitted] = useState<Record<string, string> | undefined>();

	const { data: groupsData, error: groupsError } = useQuery({
		queryKey: ['log-groups', cloudStage],
		queryFn: () => {
			// Unreachable in local: `enabled` holds this until a deployed stage is
			// selected. The guard narrows `cloudStage` without a cast and keeps the
			// stage a real one, never a placeholder.
			if (cloudStage === undefined) throw new Error('log groups requested with no stage');
			return apiGet<LogGroupsResponse>(`/api/v1/logs/groups?stage=${encodeURIComponent(cloudStage)}`);
		},
		enabled: ready && cloudStage !== undefined,
	});

	const { data: search, isFetching: searching, error: searchError } = useQuery({
		queryKey: ['log-search', submitted],
		queryFn: () => apiGet<LogSearchResponse>(`/api/v1/logs/search?${new URLSearchParams(submitted).toString()}`),
		enabled: ready && cloudStage !== undefined && submitted !== undefined,
	});

	const runSearch = (group = selectedGroup) => {
		// The search form is not rendered in local; guard anyway so `stage` is
		// always a real deployed stage and never a placeholder.
		if (cloudStage === undefined) return;
		const start = new Date(Date.now() - rangeMinutes * 60_000).toISOString();
		setSubmitted({
			stage: cloudStage,
			start,
			...(text ? { text } : {}),
			...(level ? { level } : {}),
			...(logger ? { logger } : {}),
			...(traceId ? { traceId } : {}),
			...(group ? { group } : {}),
		});
	};

	// Click-through from the groups table: scope the search to one group.
	const searchGroup = (name: string) => {
		setSelectedGroup(name);
		runSearch(name);
		window.scrollTo({ top: 0, behavior: 'smooth' });
	};

	const clearGroup = () => {
		setSelectedGroup('');
		if (submitted) runSearch('');
	};

	const inputClass =
		'rounded-md border border-line bg-panel px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40';

	// Local has no CloudWatch source at all (D76). A Logs Insights query and a
	// Live Tail session are both billed (D78), so the page states the fact
	// directly and issues nothing — not the search form, not the live-tail panel.
	if (cloudStage === undefined) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-4">
					<h1 className="text-lg font-semibold tracking-tight">Logs</h1>
				</div>
				<GuidedEmpty screen={{ kind: 'local-pillar', pillar: 'logs' }} />
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-4">
				<h1 className="text-lg font-semibold tracking-tight">Logs</h1>
			</div>

			<Card>
				<CardContent className="flex flex-wrap items-end gap-3 pt-6">
					<label className="flex flex-col gap-1 text-xs text-fg-soft">
						search text
						<input
							className={`${inputClass} w-56`}
							value={text}
							onChange={(e) => setText(e.target.value)}
							onKeyDown={(e) => e.key === 'Enter' && runSearch()}
							placeholder="free text…"
						/>
					</label>
					<label className="flex flex-col gap-1 text-xs text-fg-soft">
						level
						<select className={inputClass} value={level} onChange={(e) => setLevel(e.target.value)}>
							<option value="">any</option>
							<option value="debug">debug</option>
							<option value="info">info</option>
							<option value="warn">warn</option>
							<option value="error">error</option>
						</select>
					</label>
					<label className="flex flex-col gap-1 text-xs text-fg-soft">
						logger
						<input
							className={`${inputClass} w-36`}
							value={logger}
							onChange={(e) => setLogger(e.target.value)}
							onKeyDown={(e) => e.key === 'Enter' && runSearch()}
						/>
					</label>
					<label className="flex flex-col gap-1 text-xs text-fg-soft">
						trace id
						<input
							className={`${inputClass} w-44 font-mono`}
							value={traceId}
							onChange={(e) => setTraceId(e.target.value)}
							onKeyDown={(e) => e.key === 'Enter' && runSearch()}
						/>
					</label>
					<div className="flex flex-col gap-1 text-xs text-fg-soft">
						range
						<div className="flex gap-1 rounded-lg bg-hover p-1">
							{TIME_RANGES.map((range) => (
								<button
									key={range.label}
									type="button"
									onClick={() => setRangeMinutes(range.minutes)}
									className={`rounded-md px-2 py-1 text-xs ${
										rangeMinutes === range.minutes ? 'bg-active font-medium text-fg' : 'text-fg-soft'
									}`}
								>
									{range.label}
								</button>
							))}
						</div>
					</div>
					<button
						type="button"
						onClick={() => runSearch()}
						disabled={searching}
						className="rounded-md bg-brand px-4 py-1.5 text-sm font-medium text-on-brand hover:bg-brand-dark disabled:opacity-50"
					>
						{searching ? 'Searching…' : 'Search'}
					</button>
					{selectedGroup && (
						<button
							type="button"
							onClick={clearGroup}
							title="Clear group filter"
							className="flex items-center gap-1 rounded-full border border-line bg-hover px-3 py-1 font-mono text-xs hover:bg-active"
						>
							group: {selectedGroup.split('/').pop()} ✕
						</button>
					)}
					{search?.stats && (
						<span className="pb-1.5 text-xs text-fg-dim">
							scanned {formatBytes(search.stats.scannedBytes)} · {search.stats.matchedEvents ?? '?'} matches
						</span>
					)}
				</CardContent>
			</Card>

			{/* A thrown request has no `searchSource` to branch on, so without these
			    the Search button appeared to do nothing at all on a failure. */}
			<RequestError error={searchError} what="the log search results" />
			<RequestError error={groupsError} what="the list of log groups" />
			{search?.searchSource === 'unavailable' && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">
							{search.searchErrorCode === 'CREDENTIALS_EXPIRED'
								? 'AWS credentials expired'
								: search.searchErrorCode === 'QUERY_TIMEOUT'
									? 'Query timed out'
									: 'Search unavailable'}
						</CardTitle>
						<CardDescription>{search.searchError}</CardDescription>
					</CardHeader>
					{search.awsContext && (
						<CardContent>
							<p className="font-mono text-xs text-fg-soft">
								server resolved: profile {search.awsContext.profile ?? '(default chain)'} · region{' '}
								{search.awsContext.region ?? '(sdk default)'} ({search.awsContext.regionSource})
							</p>
						</CardContent>
					)}
				</Card>
			)}

			{search?.searchSource === 'insights' && search.entries.length === 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">
							{submitted?.group && search.queriedGroups.length === 0 ? 'No logs yet' : 'No matching log events'}
						</CardTitle>
						<CardDescription>
							{submitted?.group && search.queriedGroups.length === 0
								? 'This log group has not received any log events (CloudWatch creates it on first write).'
								: `Searched ${search.queriedGroups.length} log group${search.queriedGroups.length === 1 ? '' : 's'} in the selected range.`}
						</CardDescription>
					</CardHeader>
				</Card>
			)}

			{search?.searchSource === 'insights' && search.entries.length > 0 && (
				<Card>
					<CardContent className="p-0">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Time</TableHead>
									<TableHead>Level</TableHead>
									<TableHead>Logger</TableHead>
									<TableHead>Message</TableHead>
									<TableHead>Trace</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{search.entries.map((entry, i) => (
									<TableRow key={`${entry.timestamp}-${i}`}>
										<TableCell className="whitespace-nowrap font-mono text-xs">
											{new Date(entry.timestamp).toLocaleTimeString()}
										</TableCell>
										<TableCell>
											{entry.level ? (
												<Badge variant={LEVEL_VARIANT[entry.level] ?? 'outline'}>{entry.level}</Badge>
											) : (
												<span className="text-xs text-fg-dim">raw</span>
											)}
										</TableCell>
										<TableCell className="font-mono text-xs">{entry.logger ?? '—'}</TableCell>
										<TableCell className="max-w-2xl truncate font-mono text-xs" title={entry.message}>
											{entry.message}
										</TableCell>
										<TableCell className="font-mono text-xs text-fg-soft">
											{entry.traceId ? (
												<button type="button" className="hover:underline" onClick={() => setTraceId(entry.traceId ?? '')}>
													{entry.traceId.slice(0, 14)}…
												</button>
											) : (
												''
											)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}

			<LiveTailPanel key={cloudStage} stage={cloudStage} />

			{groupsData?.groupsSource === 'cloudformation' && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">
							{groupsData.groups.length} log group{groupsData.groups.length === 1 ? '' : 's'}
						</CardTitle>
						<CardDescription>
							Discovered from stack <code>{groupsData.stackName}</code>. Click a group to view its logs.
						</CardDescription>
					</CardHeader>
					<CardContent className="p-0">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Log group</TableHead>
									<TableHead>Source</TableHead>
									<TableHead>Retention</TableHead>
									<TableHead>Stored</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{groupsData.groups.map((group) => (
									<TableRow
										key={group.name}
										className={`cursor-pointer ${selectedGroup === group.name ? 'bg-hover' : ''}`}
										onClick={() => searchGroup(group.name)}
									>
										<TableCell className="font-mono text-xs">{group.name}</TableCell>
										<TableCell>
											<Badge variant={group.source === 'explicit' ? 'default' : 'outline'}>{group.source}</Badge>
										</TableCell>
										<TableCell>
											{group.retentionDays === null
												? 'never expires'
												: group.retentionDays !== undefined
													? `${group.retentionDays}d`
													: 'no logs yet'}
										</TableCell>
										<TableCell>{formatBytes(group.storedBytes)}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}

			{groupsData?.groupsSource === 'unavailable' && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Log groups unavailable</CardTitle>
						<CardDescription>{groupsData.groupsError}</CardDescription>
					</CardHeader>
				</Card>
			)}
		</div>
	);
}
