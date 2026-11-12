// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useEnvironment } from '@/components/environment-context';
import { GuidedEmpty } from '@/components/guided-empty';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type {
	SettingEntry,
	SettingHistoryResponse,
	SettingRevealResponse,
	SettingsResponse,
	SettingValueKind,
} from '@/contract/v1';
import { environmentSearchParams, wireStageFor } from '@/env/environment';
import { apiGet } from '@/lib/api-client';
import { apiMutate, type ObservedSettingWriteResponse } from '@/lib/api-mutate';
import {
	editability,
	groupByFile,
	initialInput,
	initialKind,
	restorableVersions,
	valueSummary,
} from '@/settings/settings-page-view';

/**
 * Settings: the app's own configuration values, per stage.
 *
 * Three things this page will not do, each of them deliberate.
 *
 * It does not pre-fill a secret's editor. The stored value was never fetched,
 * so filling the box would mean either showing a mask the user might save back
 * over the real value, or decrypting on page load, which is what the read path
 * exists to avoid. A secret is write-only here until the reader asks to see it.
 *
 * It does not offer a rollback for a secret. Parameter history is read without
 * decryption, so a secret's past values are not in hand, and a restore button
 * that cannot restore is worse than none.
 *
 * It does not claim validation it did not perform. A setting declared with a
 * schema is validated by the APP at `put()` time, and that schema lives in app
 * source this process cannot run. The row says so, in the same spirit as the
 * record editor saying a direct write bypasses the app's own logic.
 */
export default function SettingsPage() {
	const { environment, cloudStage, target, ready } = useEnvironment();
	const [open, setOpen] = useState<string | undefined>(undefined);

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: ['settings', environment],
		queryFn: () =>
			apiGet<SettingsResponse>(`/api/v1/settings?${environmentSearchParams(environment)}`),
		enabled: ready,
	});

	if (!ready || isLoading) {
		return <p className="p-6 text-sm text-fg-dim">Loading settings…</p>;
	}

	if (error) {
		return (
			<div className="p-6">
				<Card>
					<CardHeader>
						<CardTitle>Settings could not be read</CardTitle>
						<CardDescription>{error.message}</CardDescription>
					</CardHeader>
				</Card>
			</div>
		);
	}

	// A stage with no stack, or one that refused: the guided card offers the
	// switch or the deploy command rather than an empty table.
	if (data?.settingsErrorCode !== undefined) {
		return (
			<div className="p-6">
				<GuidedEmpty
					screen={
						data.settingsErrorCode === 'ACCESS_DENIED'
							? {
									kind: 'access-denied',
									permission: 'ssm:GetParameters',
									...(data.settingsError ? { detail: data.settingsError } : {}),
								}
							: {
									kind: 'not-deployed',
									stage: cloudStage ?? environment,
									...(data.settingsError ? { detail: data.settingsError } : {}),
								}
					}
				/>
			</div>
		);
	}

	const entries = data?.settings ?? [];

	return (
		<div className="flex flex-col gap-6 p-6">
			<header className="flex flex-col gap-1">
				<h1 className="font-semibold text-fg text-xl">Settings</h1>
				<p className="text-fg-soft text-sm">
					{cloudStage === undefined
						? 'Local values, read from .bb-data/settings.json.'
						: `SSM parameters in ${cloudStage}. A write here changes what the running app reads.`}
				</p>
			</header>

			{entries.length === 0 ? (
				<Card>
					<CardHeader>
						<CardTitle>This app declares no settings</CardTitle>
						<CardDescription>
							Add an <code className="font-mono">AppSetting</code> to your{' '}
							<code className="font-mono">aws-blocks/</code> source and it appears here, in every stage.
						</CardDescription>
					</CardHeader>
				</Card>
			) : (
				groupByFile(entries).map((group) => (
					<section key={group.file} className="flex flex-col gap-3">
						<h2 className="font-mono text-fg-dim text-xs">{group.file}</h2>
						{group.entries.map((entry) => (
							<SettingRow
								key={entry.fullId}
								entry={entry}
								stage={wireStageFor(target)}
								mode={target.mode}
								expanded={open === entry.fullId}
								onToggle={() => setOpen(open === entry.fullId ? undefined : entry.fullId)}
								onSaved={() => void refetch()}
							/>
						))}
					</section>
				))
			)}

			{data?.orphans.length ? (
				<Card>
					<CardHeader>
						<CardTitle>Parameters with no declaration</CardTitle>
						<CardDescription>
							Live in this stage, claimed by no <code className="font-mono">AppSetting</code> the
							dashboard could address. Some may belong to a setting whose path is built from a
							variable, so this is not a list of things to delete.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<ul className="flex flex-col gap-1 font-mono text-fg-soft text-xs">
							{data.orphans.map((address) => (
								<li key={address}>{address}</li>
							))}
						</ul>
					</CardContent>
				</Card>
			) : null}

			{data?.environment?.length ? (
				<Card>
					<CardHeader>
						<CardTitle>Environment variables</CardTitle>
						<CardDescription>
							Set by the last deploy, shown read-only. These are not editable here: the template owns
							them, so a change made outside a deploy is reverted by the next one.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<dl className="grid grid-cols-[minmax(0,16rem)_1fr] gap-x-4 gap-y-1 text-xs">
							{data.environment.map((variable) => (
								<div key={variable.key} className="contents">
									<dt className="truncate font-mono text-fg-soft">{variable.key}</dt>
									<dd className="truncate font-mono text-fg-dim">
										{variable.value ?? 'resolved at deploy time'}
									</dd>
								</div>
							))}
						</dl>
					</CardContent>
				</Card>
			) : null}
		</div>
	);
}

/** One setting: its current state, and an editor when it can be written. */
function SettingRow(props: {
	entry: SettingEntry;
	stage: string;
	mode: 'local' | 'cloud';
	expanded: boolean;
	onToggle: () => void;
	onSaved: () => void;
}) {
	const { entry, stage, mode, expanded, onToggle, onSaved } = props;
	const [input, setInput] = useState(() => initialInput(entry));
	const [kind, setKind] = useState<SettingValueKind>(() => initialKind(entry));
	// Only what the row renders. The wire response carries more, but holding the
	// whole envelope here would mean inventing an `apiVersion` for a failure the
	// server never answered.
	const [result, setResult] = useState<{ ok: boolean; message: string } | undefined>(undefined);
	const [revealed, setRevealed] = useState<string | undefined>(undefined);
	const [saving, setSaving] = useState(false);
	const [confirmProduction, setConfirmProduction] = useState('');

	const { editable, reason } = editability(entry);
	const needsConfirmation = mode === 'cloud' && stage === 'production';

	const history = useQuery({
		queryKey: ['setting-history', entry.fullId, stage, mode],
		queryFn: () =>
			apiGet<SettingHistoryResponse>(
				`/api/v1/settings/history?${new URLSearchParams({ fullId: entry.fullId, stage, mode })}`,
			),
		enabled: expanded && !entry.secret && entry.address !== undefined,
	});
	const restorable = restorableVersions(entry, history.data?.versions ?? []);

	async function save() {
		setSaving(true);
		setResult(undefined);
		try {
			const response = await apiMutate<ObservedSettingWriteResponse>('/api/v1/settings', 'PUT', {
				fullId: entry.fullId,
				stage,
				mode,
				value: input,
				kind,
				...(entry.value?.version === undefined ? {} : { expectedVersion: entry.value.version }),
				...(needsConfirmation ? { confirmStage: confirmProduction } : {}),
			});
			setResult({ ok: response.ok, message: response.message });
			if (response.ok) onSaved();
		} catch (caught) {
			setResult({ ok: false, message: (caught as Error).message });
		} finally {
			setSaving(false);
		}
	}

	async function reveal() {
		const response = await apiMutate<SettingRevealResponse>('/api/v1/settings/reveal', 'POST', {
			fullId: entry.fullId,
			stage,
			mode,
		});
		setRevealed(response.display);
	}

	return (
		// The id is on the card so a verification run can address one row
		// without guessing at the DOM shape. This package has no component
		// tests, so the browser is the only place these rows are checked.
		<Card data-setting={entry.fullId}>
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div className="flex min-w-0 flex-col gap-1">
					<CardTitle className="flex flex-wrap items-center gap-2">
						<span className="font-mono text-sm">{entry.id}</span>
						{entry.secret ? <Badge variant="warning">secret</Badge> : null}
						{entry.external ? <Badge variant="outline">owned elsewhere</Badge> : null}
						{entry.hasSchema ? <Badge variant="outline">schema</Badge> : null}
						{entry.presence === 'absent' ? <Badge variant="warning">not set here</Badge> : null}
					</CardTitle>
					<CardDescription className="truncate font-mono text-xs">
						{entry.address ?? 'no resolvable path'}
					</CardDescription>
					<p className="truncate text-fg-soft text-sm">{revealed ?? valueSummary(entry)}</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{entry.secret && entry.presence === 'present' ? (
						<button
							type="button"
							onClick={() => void reveal()}
							className="rounded-md border border-line px-2 py-1 text-fg-soft text-xs hover:bg-hover"
						>
							{revealed === undefined ? 'Reveal' : 'Shown'}
						</button>
					) : null}
					<button
						type="button"
						onClick={onToggle}
						className="rounded-md border border-line px-2 py-1 text-fg text-xs hover:bg-hover"
					>
						{expanded ? 'Close' : 'Edit'}
					</button>
				</div>
			</CardHeader>

			{expanded ? (
				<CardContent className="flex flex-col gap-3">
					{!editable ? (
						<p className="text-fg-soft text-sm">{reason}</p>
					) : (
						<>
							{entry.secret ? (
								<p className="text-fg-dim text-xs">
									Write-only: the box starts empty so a mask can never be saved over the real value.
								</p>
							) : null}
							{entry.external ? (
								<p className="text-fg-dim text-xs">
									This parameter is created outside the stack, so whatever seeds it will overwrite
									this on its next run.
								</p>
							) : null}
							{entry.hasSchema ? (
								<p className="text-fg-dim text-xs">
									The app validates this against a schema that the dashboard cannot run, so a value
									it rejects fails at the app's next read rather than here.
								</p>
							) : null}
							{entry.value?.encoding === 'raw' ? (
								<p className="text-fg-dim text-xs">
									Stored in the pre-JSON format, so saving rewrites it in the format the app writes
									today.
								</p>
							) : null}

							<div className="flex items-center gap-2 text-xs">
								{(['text', 'json'] as const).map((option) => (
									<button
										key={option}
										type="button"
										onClick={() => setKind(option)}
										className={
											kind === option
												? 'rounded-md bg-brand px-2 py-1 text-on-brand'
												: 'rounded-md border border-line px-2 py-1 text-fg-soft hover:bg-hover'
										}
									>
										{option === 'text' ? 'Text' : 'JSON'}
									</button>
								))}
								<span className="text-fg-dim">
									{kind === 'text'
										? 'Stored as a string, so 5 stays "5".'
										: 'Parsed first, so the app receives the value, not its source text.'}
								</span>
							</div>

							<textarea
								value={input}
								onChange={(event) => setInput(event.target.value)}
								rows={kind === 'json' ? 5 : 2}
								spellCheck={false}
								className="w-full rounded-md border border-line bg-canvas p-2 font-mono text-fg text-xs"
								placeholder={entry.secret ? 'New value' : 'Value'}
							/>

							{needsConfirmation ? (
								<label className="flex flex-col gap-1 text-xs">
									<span className="text-fg-soft">
										Type <code className="font-mono">production</code> to confirm a write to the live
										stage.
									</span>
									<input
										value={confirmProduction}
										onChange={(event) => setConfirmProduction(event.target.value)}
										className="w-48 rounded-md border border-line bg-canvas px-2 py-1 font-mono text-fg"
									/>
								</label>
							) : null}

							<div className="flex items-center gap-3">
								<button
									type="button"
									onClick={() => void save()}
									disabled={saving}
									className="rounded-md bg-brand px-3 py-1.5 font-medium text-on-brand text-xs hover:bg-brand-dark disabled:opacity-60"
								>
									{saving ? 'Saving…' : 'Save'}
								</button>
								{result ? (
									<p className={result.ok ? 'text-fg-soft text-xs' : 'text-fg text-xs'}>
										{result.message}
									</p>
								) : null}
							</div>

							{restorable.length > 0 ? (
								<div className="flex flex-col gap-1 border-line border-t pt-3">
									<p className="text-fg-dim text-xs">
										Earlier versions. Restoring puts the old value in the box so you can see what you
										are about to save.
									</p>
									<ul className="flex flex-wrap gap-2">
										{restorable.slice(0, 5).map((version) => (
											<li key={version.version}>
												<button
													type="button"
													onClick={() => setInput(version.display ?? '')}
													className="rounded-md border border-line px-2 py-1 font-mono text-fg-soft text-xs hover:bg-hover"
												>
													v{version.version}
												</button>
											</li>
										))}
									</ul>
								</div>
							) : null}
						</>
					)}
				</CardContent>
			) : null}
		</Card>
	);
}
