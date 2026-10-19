// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Pencil, Plus } from 'lucide-react';
import Link from 'next/link';
import { Fragment, use, useEffect, useState } from 'react';
import { useEnvironment } from '@/components/environment-context';
import { GuidedEmpty } from '@/components/guided-empty';
import { JsonView, REDACTED_MARKER, summarizeJson } from '@/components/json-view';
import { RecordDeleteButton, RecordEditor } from '@/components/record-editor';
import { RequestError } from '@/components/request-error';
import { ConsoleLinkNote, ResourceTable } from '@/components/resource-table';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { UnlockControl, useCloudWriteLock } from '@/components/unlock-control';
import type {
	BlocksResponse,
	DataPageResponse,
	DataRecord,
	DataStore,
	EnvironmentsResponse,
	ResourcesResponse,
	WriteMode,
} from '@/contract/v1';
import { blockedReasonFor, environmentSearchParams, isProductionEnvironment, wireStageFor } from '@/env/environment';
import { apiGet } from '@/lib/api-client';
import { UNMATCHED_BADGE_TITLE, groupsByBlock, reasonForBlock, stageUnmatchedReason } from '@/nav/inventory-tree';
import type { ResourcesState } from '@/nav/inventory-tree';

const PAGE_SIZE = 50;

const ERROR_TITLE: Record<string, string> = {
	BLOCK_NOT_FOUND: 'Block not declared in this project',
	STORE_NOT_FOUND: 'Store not found',
	ACCESS_DENIED: 'Access denied',
	UNPARSEABLE: 'Store could not be read',
	CREDENTIALS_EXPIRED: 'AWS credentials expired',
	CREDENTIALS_MISSING: 'No AWS credentials',
	STACK_NOT_FOUND: 'Stack not found',
	UNKNOWN: 'Data unavailable',
};

const STORE_KIND_TITLE: Record<DataStore['kind'], string> = {
	'bb-data-file': 'A JSON file under .bb-data/ on this machine.',
	dynamodb: 'A DynamoDB table in the deployed stack.',
	'cognito-user-pool': 'A Cognito user pool in the deployed stack.',
};

/**
 * The key column, rendered as its labelled segments. A composite key means two
 * fields, and `userId · todoId` as one opaque string hides which half is which.
 */
function KeyCell({ record, keyFields }: { record: DataRecord; keyFields: string[] }) {
	const present = record.keyValues ? keyFields.filter((field) => record.keyValues?.[field] !== undefined) : [];
	if (present.length === 0) {
		return <span className="break-all font-mono text-xs">{record.key}</span>;
	}
	return (
		<div className="flex flex-col gap-0.5">
			{present.map((field) => (
				<span key={field} className="break-all font-mono text-xs">
					<span className="text-fg-dim">{field} </span>
					{record.keyValues?.[field]}
				</span>
			))}
		</div>
	);
}

/** The open record editor: what it writes, and which row it was opened from. */
interface EditorState {
	writeMode: WriteMode;
	/** Absent for a create — there is no row it belongs to yet. */
	rowId?: string;
	record?: DataRecord;
}

/**
 * The deployed CloudFormation resources attributed to this block.
 *
 * Resources used to live only on their own page. Now that the inventory is one
 * tree, a block's own resources belong on the block — but the empty case is the
 * part that matters: "no resources here" has four different meanings, and the
 * one sentence that used to cover all of them always blamed an undeployed
 * stage. The reason comes from the same tested helpers the nav and the index use
 * rather than a third phrasing of it here.
 */
function BlockResources({ fullId, blockType, stage }: { fullId: string; blockType?: string; stage: string }) {
	const { data, isPending, isError, error } = useQuery({
		// Same key as the nav and the Resources page, so this adds no request.
		queryKey: ['resources', stage],
		queryFn: () => apiGet<ResourcesResponse>(`/api/v1/resources?stage=${encodeURIComponent(stage)}`),
		// The gate every other cloud read carries, even though the render site
		// already withholds this component in the local environment (D78). Relying
		// on the caller alone made this the one cloud query in the package whose
		// safety lived outside itself, so moving or unconditionally rendering the
		// card would have reintroduced a billed read with nothing to catch it.
		enabled: stage !== '',
	});

	const state: ResourcesState = isPending
		? { state: 'pending' }
		: isError || !data
			? { state: 'error' }
			: { state: 'loaded', response: data };
	const matched = groupsByBlock(data?.groups ?? []).get(fullId) ?? [];
	// With no block in the source scan there is no type, so the type-based
	// override cannot apply and the stage-level reason stands — which is correct:
	// we know nothing about a block we never parsed.
	const reason = reasonForBlock(blockType ?? '', stageUnmatchedReason(state));
	const total = matched.reduce((count, group) => count + group.resources.length, 0);
	const hasConsoleLinks = matched.some((group) => group.resources.some((resource) => resource.consoleUrl));

	return (
		<Card>
			<CardHeader className="py-4">
				<CardTitle className="text-base">Deployed resources</CardTitle>
				<CardDescription>
					{total > 0 ? (
						<>
							{total} resource{total === 1 ? '' : 's'} in the deployed{' '}
							<span className="font-medium text-fg-soft">{stage}</span> stack, attributed to{' '}
							{matched.map((group, index) => (
								<Fragment key={group.id}>
									{index > 0 && ', '}
									<code className="font-mono text-xs">{group.id}</code>
								</Fragment>
							))}
						</>
					) : isPending ? (
						'Reading the deployed stack…'
					) : (
						UNMATCHED_BADGE_TITLE[reason]
					)}
				</CardDescription>
			</CardHeader>
			{(isError || hasConsoleLinks) && (
				<CardContent className="space-y-2">
					<RequestError error={error} what="the deployed resources" />
					{hasConsoleLinks && <ConsoleLinkNote region={data?.awsContext?.region} />}
				</CardContent>
			)}
			{matched.map((group) => (
				<CardContent key={group.id} className="p-0">
					<ResourceTable resources={group.resources} />
				</CardContent>
			))}
		</Card>
	);
}

export default function BlockDetailPage({ params }: { params: Promise<{ fullId: string }> }) {
	// Next decodes the dynamic segment, so this is the plain fullId; it is
	// re-encoded on the way back out into the API path.
	const { fullId } = use(params);
	const { environment, cloudStage, target, ready, status } = useEnvironment();
	const queryClient = useQueryClient();

	const [store, setStore] = useState<string | undefined>();
	const [cursor, setCursor] = useState<string | undefined>();
	const [pageNumber, setPageNumber] = useState(1);
	const [openRow, setOpenRow] = useState<string | undefined>();
	const [editor, setEditor] = useState<EditorState | undefined>();

	// The server owns the cloud-write lock; this only mirrors it, and only asks
	// about it in the cloud environment — local writes are not gated by that window.
	const lock = useCloudWriteLock(target.mode === 'cloud');

	const { data: blocksData } = useQuery({
		queryKey: ['blocks'],
		queryFn: () => apiGet<BlocksResponse>('/api/v1/blocks'),
	});
	const block = blocksData?.blocks.find((candidate) => candidate.fullId === fullId);

	const { data: envData } = useQuery({
		queryKey: ['environments'],
		queryFn: () => apiGet<EnvironmentsResponse>('/api/v1/environments'),
	});
	// The deployed-stack facts (stack name, region) for the selected cloud stage;
	// undefined in the local environment, where no banner reads them.
	const selectedEnvInfo = envData?.environments.find((candidate) => candidate.stage === cloudStage);
	// Blocked if and only if the selected environment is not selectable, which is
	// only the not-deployed case — an `unknown` state is NOT blocked and still
	// issues its request, exactly as the old code did.
	const blockedReason = blockedReasonFor(status);
	// Paired, rather than carried as a bare sentence: a reason with no stage
	// attached is how this strip came to state a problem while offering no way
	// out of it. `status.id` is the blocked environment by construction.
	const blocked = status && blockedReason ? { stage: status.id, detail: blockedReason } : undefined;

	// A cursor is forward-only and store-scoped, so it cannot survive a change of
	// environment or store. Reset the paging position rather than replay it — and
	// close the editor, whose draft was addressed at the store being left.
	useEffect(() => {
		setCursor(undefined);
		setPageNumber(1);
		setOpenRow(undefined);
		setEditor(undefined);
	}, [environment, store]);

	// `mode` always, `stage` only when cloud, so a local read no longer sends a
	// stage the server would ignore.
	const search = environmentSearchParams(environment, { limit: String(PAGE_SIZE) });
	if (store) search.set('store', store);
	if (cursor) search.set('cursor', cursor);

	const { data, isLoading, isFetching, error } = useQuery({
		queryKey: ['data', fullId, environment, store, cursor],
		queryFn: () => apiGet<DataPageResponse>(`/api/v1/data/${encodeURIComponent(fullId)}?${search.toString()}`),
		// Nothing is read until the stored environment selection has been applied
		// (so the first read is not made against the default), and nothing is read
		// against a not-deployed stack that has nothing to return.
		enabled: ready && !blocked,
		// Keep the current page on screen while the next one loads: paging must
		// not blank the table out from under the reader.
		placeholderData: (previous) => previous,
	});

	const stores = data?.stores ?? [];
	const activeStore = stores.find((candidate) => candidate.id === (data?.activeStore ?? store));
	const storeLabel = activeStore?.label ?? data?.activeStore ?? 'this store';
	const keyFields = data?.keyFields ?? [];
	const records = data?.records ?? [];
	const unavailable = data?.dataSource === 'unavailable';
	const production = isProductionEnvironment(environment);

	// Writes target the store actually being read, which the server may have
	// picked for us when no `?store=` was sent.
	const activeStoreId = data?.activeStore ?? store;

	/**
	 * Why writes are unavailable, or `undefined` when they are available. Local
	 * writes need no unlock; cloud writes are gated by the server's lock, and
	 * this is a mirror of it rather than a second opinion. Rendered next to the
	 * controls rather than only used to disable them, so the gate is learnable.
	 */
	const writeGateReason =
		target.mode === 'cloud' && !lock.unlocked
			? lock.loading
				? 'Checking with the server whether cloud writes are unlocked…'
				: `Cloud writes to ${target.stage} are locked, so records here are read-only. Unlock writes above to create, edit or delete.`
			: undefined;
	const writesEnabled = writeGateReason === undefined;

	const refreshRecords = () => {
		void queryClient.invalidateQueries({ queryKey: ['data', fullId] });
	};

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-3">
				<Link href="/blocks" className="text-sm text-fg-soft hover:text-fg">
					← Blocks
				</Link>
			</div>

			<div className="flex flex-wrap items-center gap-3">
				<h1 className="font-mono text-lg font-semibold tracking-tight">{fullId}</h1>
				{block && <Badge variant="outline">{block.type}</Badge>}
				{block && <Badge variant="outline">{block.category}</Badge>}
			</div>

			<Card>
				<CardHeader className="py-4">
					<CardTitle className="text-base">Block</CardTitle>
					<CardDescription>
						{block ? (
							<>
								<code className="font-mono text-xs">{block.type}</code> declared as{' '}
								<code className="font-mono text-xs">{block.id}</code> at{' '}
								<code className="font-mono text-xs">
									{block.file}:{block.line}
								</code>
							</>
						) : (
							<>
								Not found in the source scan of this project — the record browser below still reports what the server
								finds for <code className="font-mono text-xs">{fullId}</code>.
							</>
						)}
					</CardDescription>
				</CardHeader>
				{block?.keySchema && (
					<CardContent className="text-[13px]">
						<div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
							<span className="text-fg-soft">Key schema</span>
							<span className="font-mono text-xs">
								partition <span className="text-fg">{block.keySchema.partitionKey}</span>
								{block.keySchema.sortKey ? (
									<>
										{' · '}sort <span className="text-fg">{block.keySchema.sortKey}</span>
									</>
								) : (
									<span className="text-fg-dim"> · no sort key</span>
								)}
							</span>
							<span className="text-xs text-fg-dim">
								These are the attributes the key column below is made of.
							</span>
						</div>
					</CardContent>
				)}
			</Card>

			{ready && !blocked && target.mode === 'cloud' && (
				<BlockResources fullId={fullId} blockType={block?.type} stage={target.stage} />
			)}

			<Card>
				<CardContent className="space-y-3 pt-4">
					{blocked ? (
						<GuidedEmpty screen={{ kind: 'not-deployed', ...blocked }} variant="inline" />
					) : target.mode === 'cloud' ? (
						<div
							className={`flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs ${
								production ? 'border-danger/30 bg-danger/5' : 'border-warn/25 bg-warn/5'
							}`}
						>
							<Badge variant={production ? 'destructive' : 'warning'}>
								{production ? `live production data · ${target.stage}` : `cloud data · ${target.stage}`}
							</Badge>
							<span className="text-fg-soft">
								Reading the deployed <span className="font-medium text-fg">{target.stage}</span> stack
								{selectedEnvInfo?.stackName && (
									<>
										{' '}
										<code className="font-mono">{selectedEnvInfo.stackName}</code>
									</>
								)}
								{selectedEnvInfo?.region && (
									<>
										{' in '}
										<code className="font-mono">{selectedEnvInfo.region}</code>
									</>
								)}
								. Switch the environment in the header above to read a different one.
							</span>
						</div>
					) : (
						<div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-hover px-3 py-2 text-xs">
							<Badge variant="outline">local data</Badge>
							<span className="text-fg-soft">
								Reading the <code className="font-mono">.bb-data</code> store on this machine. Nothing deployed is
								touched.
							</span>
						</div>
					)}

					{stores.length > 1 && (
						<div className="space-y-1.5">
							<span className="text-xs text-fg-soft">
								This block is spread across {stores.length} stores — pick one to read.
							</span>
							<div role="group" aria-label="Store to read records from" className="flex flex-wrap gap-1.5">
								{stores.map((candidate) => {
									const active = candidate.id === (data?.activeStore ?? store);
									return (
										<button
											key={candidate.id}
											type="button"
											onClick={() => setStore(candidate.id)}
											aria-pressed={active}
											title={STORE_KIND_TITLE[candidate.kind]}
											className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
												active ? 'border-line bg-active text-fg' : 'border-line-soft text-fg-soft hover:bg-hover'
											}`}
										>
											{candidate.label}
											<span className="font-mono text-[11px] text-fg-dim">{candidate.kind}</span>
											{candidate.ancillary && (
												<Badge
													variant="outline"
													title="Ancillary store: verification codes, sessions, tokens and challenges live here. Usually empty — an empty ancillary store is normal, not a fault."
												>
													ancillary
												</Badge>
											)}
										</button>
									);
								})}
							</div>
						</div>
					)}
				</CardContent>
			</Card>

			{error && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Cannot reach the Dashboard API</CardTitle>
						<CardDescription>
							Start the dashboard via <code>npm run dashboard</code> so the session token is set. ({String(error)})
						</CardDescription>
					</CardHeader>
				</Card>
			)}

			{unavailable && data && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">{ERROR_TITLE[data.dataErrorCode ?? 'UNKNOWN'] ?? 'Data unavailable'}</CardTitle>
						<CardDescription>{data.dataError}</CardDescription>
					</CardHeader>
					<CardContent className="space-y-2 text-[13px] text-fg-soft">
						{data.dataErrorCode === 'BLOCK_NOT_FOUND' && (
							<p>
								<code className="font-mono">{fullId}</code> is not declared in this project. Nothing under{' '}
								<code className="font-mono">aws-blocks/</code> creates it, so there is no store to read — check the id
								against the <Link href="/blocks" className="hover:text-fg hover:underline">
									blocks list
								</Link>
								.
							</p>
						)}
						{data.awsContext && (
							<p className="font-mono text-xs">
								server resolved: profile {data.awsContext.profile ?? '(default chain)'} · region{' '}
								{data.awsContext.region ?? '(sdk default)'} ({data.awsContext.regionSource})
							</p>
						)}
					</CardContent>
				</Card>
			)}

			{data?.redacted && (
				<div className="flex flex-wrap items-start gap-2 rounded-md border border-warn/20 bg-warn/5 px-3 py-2 text-xs">
					<Badge variant="warning">masked</Badge>
					<p className="max-w-3xl text-fg-soft">
						Values on this page matched a credential shape (password hash, API key, token, secret) and were replaced with{' '}
						<code className="font-mono text-warn-fg">{REDACTED_MARKER}</code> on the server, before the records reached
						this browser. The bullets are deliberate, not data loss: the stored records still hold their real values.
					</p>
				</div>
			)}

			{data && !unavailable && (
				<Card>
					<CardHeader className="py-3">
						<CardTitle className="text-base">Change records</CardTitle>
						<CardDescription>
							{target.mode === 'cloud'
								? `Creates, edits and deletes here go to the deployed ${target.stage} store — there is no staging copy in between.`
								: 'Creates, edits and deletes here change the .bb-data store on this machine. Nothing deployed is touched.'}
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-3">
						{/* The asymmetry, stated where the controls are: cloud writes are
						    gated by a server-side unlock, local writes are not gated but
						    are refused while the dev server owns the store. */}
						{target.mode === 'cloud' ? (
							<UnlockControl stage={target.stage} lock={lock} />
						) : (
							<div className="flex flex-wrap items-start gap-2 rounded-md border border-line bg-hover px-3 py-2 text-xs">
								<Badge variant="outline">no unlock needed</Badge>
								<p className="max-w-3xl text-fg-soft">
									Local writes are not behind the cloud unlock — this store is a file on your own machine. One thing
									does refuse them: while the local dev server is running it holds this store in memory and would
									write its own copy back over your change, so a save is refused with that reason until you stop it.
									That is a refusal, not a failure, and it says so when it happens.
								</p>
							</div>
						)}

						<div className="flex flex-wrap items-center gap-3">
							<button
								type="button"
								onClick={() => setEditor({ writeMode: 'create' })}
								disabled={!writesEnabled || editor !== undefined}
								title={
									writeGateReason ??
									(editor ? 'Close the editor below first.' : `Create a new record in ${storeLabel}.`)
								}
								className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-fg-soft transition-colors hover:bg-active hover:text-fg disabled:cursor-not-allowed disabled:border-line-soft disabled:text-fg-dim disabled:hover:bg-transparent disabled:hover:text-fg-dim"
							>
								<Plus size={12} strokeWidth={2.2} aria-hidden="true" />
								New record
							</button>
							{/* Shown rather than hidden: a control that quietly vanishes never
							    teaches the reader that a gate exists at all. */}
							{writeGateReason && <span className="max-w-2xl text-xs text-fg-dim">{writeGateReason}</span>}
						</div>

						{editor && (
							<RecordEditor
								// Keyed on the row so opening a different record re-seeds the
								// draft, while flipping create/edit on the same one keeps it.
								key={editor.rowId ?? 'create'}
								fullId={fullId}
								stage={wireStageFor(target)}
								mode={target.mode}
								store={activeStoreId}
								keyFields={keyFields}
								writeMode={editor.writeMode}
								record={editor.record}
								onWriteModeChange={(next) =>
									setEditor((current) => (current ? { ...current, writeMode: next } : current))
								}
								onClose={() => setEditor(undefined)}
								onSaved={refreshRecords}
								onLockLapsed={lock.resync}
							/>
						)}
					</CardContent>
				</Card>
			)}

			{isLoading && !data && <p className="text-sm text-fg-soft">Loading records…</p>}

			{data && !unavailable && records.length === 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">No records in {storeLabel}</CardTitle>
						<CardDescription>
							{activeStore?.ancillary
								? 'This is an ancillary store — verification codes, sessions and tokens live here and it is usually empty. Nothing is wrong.'
								: `The store was read successfully and holds no records ${
										target.mode === 'cloud' ? `in ${target.stage}` : 'on this machine'
									}.`}
						</CardDescription>
					</CardHeader>
				</Card>
			)}

			{data && !unavailable && records.length > 0 && (
				<Card>
					<CardContent className="p-0">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead scope="col" className="w-1/3">
										{keyFields.length > 0 ? keyFields.join(' · ') : 'Key'}
									</TableHead>
									<TableHead scope="col">Value</TableHead>
									<TableHead scope="col" className="whitespace-nowrap text-right">
										Actions
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{records.map((record, index) => {
									const rowId = `${index}:${record.key}`;
									const open = openRow === rowId;
									const Chevron = open ? ChevronDown : ChevronRight;
									return (
										<Fragment key={rowId}>
											<TableRow>
												<TableCell className="align-top">
													<KeyCell record={record} keyFields={keyFields} />
												</TableCell>
												<TableCell className="align-top">
													<div className="flex items-start gap-2">
														<button
															type="button"
															onClick={() => setOpenRow(open ? undefined : rowId)}
															aria-expanded={open}
															aria-label={`${open ? 'Collapse' : 'Expand'} the value of record ${record.key}`}
															className="flex min-w-0 items-baseline gap-1.5 text-left transition-colors hover:text-fg"
														>
															<Chevron
																size={12}
																strokeWidth={2}
																className="shrink-0 translate-y-px text-fg-dim"
																aria-hidden="true"
															/>
															<span className="truncate font-mono text-xs text-fg-soft">
																{summarizeJson(record.value)}
															</span>
														</button>
														{record.redacted && (
															<Badge
																variant="warning"
																title="This record contains a value that was masked on the server before it reached the browser."
															>
																masked
															</Badge>
														)}
													</div>
												</TableCell>
												<TableCell className="align-top">
													<div className="flex items-start justify-end gap-1.5">
														<button
															type="button"
															onClick={() => setEditor({ writeMode: 'edit', rowId, record })}
															disabled={!writesEnabled || editor !== undefined}
															title={
																writeGateReason ??
																(editor ? 'Close the open editor first.' : `Edit the record ${record.key}`)
															}
															aria-label={`Edit record ${record.key}`}
															className="rounded-md border border-line p-1 text-fg-soft transition-colors hover:bg-active hover:text-fg disabled:cursor-not-allowed disabled:border-line-soft disabled:text-fg-dim disabled:hover:bg-transparent disabled:hover:text-fg-dim"
														>
															<Pencil size={12} strokeWidth={2} aria-hidden="true" />
														</button>
														<RecordDeleteButton
															fullId={fullId}
															stage={wireStageFor(target)}
															mode={target.mode}
															store={activeStoreId}
															record={record}
															disabledReason={writeGateReason}
															onDeleted={refreshRecords}
															onLockLapsed={lock.resync}
														/>
													</div>
												</TableCell>
											</TableRow>
											{open && (
												<TableRow>
													<TableCell colSpan={3} className="bg-hover py-3">
														<JsonView value={record.value} rootName={record.key} />
													</TableCell>
												</TableRow>
											)}
										</Fragment>
									);
								})}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}

			{data && !unavailable && (
				<div className="flex flex-wrap items-center gap-3 text-xs">
					{data.totalRecordsExact ? (
						<span className="text-fg-soft" title="Exact: the whole store was read.">
							{data.totalRecords} record{data.totalRecords === 1 ? '' : 's'}
						</span>
					) : (
						<>
							<span
								className="text-fg-soft"
								title="Not a total. A DynamoDB scan cannot know a table's true size without paying for a full scan, so this counts only the records read so far — there may be more."
							>
								{data.totalRecords} record{data.totalRecords === 1 ? '' : 's'} so far
							</span>
							<Badge
								variant="outline"
								title="Not a total. A DynamoDB scan cannot know a table's true size without paying for a full scan."
							>
								count so far, not a total
							</Badge>
						</>
					)}
					<span className="text-fg-dim">page {pageNumber}</span>
					<button
						type="button"
						onClick={() => {
							setCursor(undefined);
							setPageNumber(1);
							setOpenRow(undefined);
						}}
						disabled={cursor === undefined}
						title="Cursors are forward-only, so this is how you get back — it re-reads the first page."
						className="rounded-md border border-line px-2.5 py-1 text-fg-soft transition-colors hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:border-line-soft disabled:text-fg-dim disabled:hover:bg-transparent"
					>
						← First page
					</button>
					<button
						type="button"
						onClick={() => {
							setCursor(data.nextCursor);
							setPageNumber((current) => current + 1);
							setOpenRow(undefined);
						}}
						disabled={data.nextCursor === undefined}
						title={
							data.nextCursor === undefined
								? 'This is the last page — the store returned no continuation token.'
								: 'Read the next page of records.'
						}
						className="rounded-md border border-line px-2.5 py-1 text-fg-soft transition-colors hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:border-line-soft disabled:text-fg-dim disabled:hover:bg-transparent"
					>
						Next page →
					</button>
					{isFetching && <span className="text-fg-dim">Loading…</span>}
				</div>
			)}
		</div>
	);
}