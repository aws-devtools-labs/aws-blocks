// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useQuery } from '@tanstack/react-query';
import { History, Terminal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useEnvironment } from '@/components/environment-context';
import { GuidedEmpty } from '@/components/guided-empty';
import { type PlaygroundCall, RpcInvoker, RpcResultView, classifyOutcome } from '@/components/rpc-invoker';
import {
	type MethodRef,
	RpcMethodPicker,
	asPlaygroundNamespaces,
	qualifiedName,
} from '@/components/rpc-method-picker';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { DataMode, EnvironmentInfo, EnvironmentsResponse, RpcMethodsResponse } from '@/contract/v1';
import { blockedReasonFor, isProductionEnvironment, wireStageFor } from '@/env/environment';
import { apiGet } from '@/lib/api-client';

/** How many calls the session history keeps. In memory only — never persisted. */
const HISTORY_LIMIT = 12;

/** Output key the deployed stack publishes its RPC base URL under. */
const API_URL_OUTPUT_KEY = 'ApiUrl';

/** Badge per outcome, so a history row reads at a glance. */
const OUTCOME_BADGE: Record<
	ReturnType<typeof classifyOutcome>,
	{ label: string; variant: 'success' | 'outline' | 'warning' | 'destructive' }
> = {
	success: { label: 'result', variant: 'success' },
	application: { label: 'app error', variant: 'outline' },
	protocol: { label: 'not dispatched', variant: 'warning' },
	http: { label: 'upstream status', variant: 'warning' },
	transport: { label: 'no answer', variant: 'destructive' },
};

/**
 * Where the current selection resolves to, stated BEFORE any call.
 *
 * The exact URL is derived server-side (nothing the browser sends may influence
 * it), so this names the source it comes from and the concrete value whenever
 * the dashboard already knows it — the stack's `ApiUrl` output in cloud mode.
 * Every result then repeats the endpoint verbatim, which is the authoritative
 * answer to "which environment answered".
 */
function EndpointNotice({
	mode,
	stage,
	environment,
}: {
	mode: DataMode;
	stage: string;
	environment?: EnvironmentInfo;
}) {
	const production = isProductionEnvironment(stage);
	const apiUrl = environment?.outputs?.[API_URL_OUTPUT_KEY];

	if (mode === 'local') {
		return (
			<div className="flex flex-wrap items-start gap-2 rounded-md border border-line bg-hover px-3 py-2 text-xs">
				<Badge variant="outline">local dev server</Badge>
				<p className="max-w-3xl text-fg-soft">
					Calls go to <code className="font-mono">http://localhost:&lt;port&gt;/aws-blocks/api</code> on this machine —
					the port read from your app's own dev-server script, falling back to 3000. Nothing deployed is touched. If the
					dev server is not running the call comes back <span className="font-medium text-fg">UNREACHABLE</span> rather
					than reaching anything else.
				</p>
			</div>
		);
	}

	return (
		<div
			className={`flex flex-wrap items-start gap-2 rounded-md border px-3 py-2 text-xs ${
				production ? 'border-danger/30 bg-danger/5' : 'border-warn/25 bg-warn/5'
			}`}
		>
			<Badge variant={production ? 'destructive' : 'warning'}>
				{production ? `live production · ${stage}` : `cloud · ${stage}`}
			</Badge>
			<p className="max-w-3xl text-fg-soft">
				Calls go to the deployed <span className="font-medium text-fg">{stage}</span> stack
				{environment?.stackName && (
					<>
						{' '}
						<code className="font-mono">{environment.stackName}</code>
					</>
				)}
				{environment?.region && (
					<>
						{' in '}
						<code className="font-mono">{environment.region}</code>
					</>
				)}
				, at its <code className="font-mono">{API_URL_OUTPUT_KEY}</code> output
				{apiUrl ? (
					<>
						{' — '}
						<code className="break-all font-mono text-fg">{apiUrl}</code>
					</>
				) : (
					<>
						, which the dashboard resolves when the call is made (the stack's output first, the deploy-time{' '}
						<code className="font-mono">.blocks-sandbox/config.json</code> only as a fallback)
					</>
				)}
				. Switch the environment in the header above to target a different one.
			</p>
		</div>
	);
}

/** One row of the session history, expandable into its full result. */
function HistoryRow({
	call,
	expanded,
	onToggle,
	onReuse,
}: {
	call: PlaygroundCall;
	expanded: boolean;
	onToggle: () => void;
	onReuse: () => void;
}) {
	const qualified = qualifiedName({ namespace: call.namespace, method: call.method });
	const badge = OUTCOME_BADGE[classifyOutcome(call.result)];
	return (
		<div className="space-y-1.5 border-b border-line-soft px-3 py-2 last:border-b-0">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<Badge variant={badge.variant}>{badge.label}</Badge>
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={expanded}
					className="font-mono text-xs text-fg-soft transition-colors hover:text-fg"
				>
					{qualified}
					<span className="text-fg-dim">({call.fields.join(', ')})</span>
				</button>
				<span className="text-[11px] text-fg-dim">
					{call.mode === 'cloud' ? `cloud · ${call.stage}` : 'local'} · {call.result.durationMs} ms ·{' '}
					{call.result.httpStatus === 0 ? 'no response' : `HTTP ${call.result.httpStatus}`}
				</span>
				<button
					type="button"
					onClick={onReuse}
					title="Fill the form with this call's parameters. It does not re-send — a cloud call is still confirmed on its own."
					className="rounded-md border border-line px-2 py-0.5 text-[11px] text-fg-soft transition-colors hover:bg-active hover:text-fg"
				>
					Reuse params
				</button>
			</div>
			{expanded && <RpcResultView result={call.result} method={qualified} />}
		</div>
	);
}

export default function PlaygroundPage() {
	const { cloudStage, target, status } = useEnvironment();

	const [selected, setSelected] = useState<MethodRef | undefined>();
	const [history, setHistory] = useState<PlaygroundCall[]>([]);
	const [expandedCall, setExpandedCall] = useState<number | undefined>();
	/** Bumped on a reuse so the invoker re-seeds its fields from the replay. */
	const [replay, setReplay] = useState<{ nonce: number; fields: string[] } | undefined>();

	const {
		data: methodsData,
		isLoading,
		error,
	} = useQuery({
		queryKey: ['rpc-methods'],
		queryFn: () => apiGet<RpcMethodsResponse>('/api/v1/rpc/methods'),
	});

	const { data: envData } = useQuery({
		queryKey: ['environments'],
		queryFn: () => apiGet<EnvironmentsResponse>('/api/v1/environments'),
	});
	// The deployed-stack facts for the selected cloud stage; undefined in the
	// local environment, where the endpoint notice reads none of them.
	const selectedEnvInfo = envData?.environments.find((candidate) => candidate.stage === cloudStage);
	// Blocked only when the selected environment is not-deployed; an `unknown`
	// state is not blocked and still lets a call be attempted.
	const blockedReason = blockedReasonFor(status);
	// Paired, rather than carried as a bare sentence: a reason with no stage
	// attached is exactly how this strip came to state a problem while offering
	// no way out of it. `status.id` is the blocked environment by construction,
	// since the reason came from that status.
	const blocked = status && blockedReason ? { stage: status.id, detail: blockedReason } : undefined;

	const namespaces = useMemo(
		() => (methodsData ? asPlaygroundNamespaces(methodsData.namespaces) : []),
		[methodsData],
	);

	const selectedNamespace = namespaces.find((candidate) => candidate.namespace === selected?.namespace);
	const selectedMethod = selectedNamespace?.methods.find((candidate) => candidate.name === selected?.method);

	const recordCall = (call: Omit<PlaygroundCall, 'id'>) => {
		setHistory((current) => [{ ...call, id: (current[0]?.id ?? 0) + 1 }, ...current].slice(0, HISTORY_LIMIT));
	};

	const reuse = (call: PlaygroundCall) => {
		setSelected({ namespace: call.namespace, method: call.method });
		setReplay({ nonce: Date.now(), fields: [...call.fields] });
	};

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-center gap-3">
				<Terminal size={18} strokeWidth={1.9} className="text-brand" aria-hidden="true" />
				<h1 className="text-lg font-semibold tracking-tight">Playground</h1>
				<span className="text-[13px] text-fg-soft">
					Call your app's own API methods and read what comes back.
				</span>
			</div>

			<Card>
				<CardContent className="space-y-3 pt-4">
					{blocked ? (
						<GuidedEmpty screen={{ kind: 'not-deployed', ...blocked }} variant="inline" />
					) : (
						<EndpointNotice
							mode={target.mode}
							stage={wireStageFor(target)}
							environment={selectedEnvInfo}
						/>
					)}
					<p className="text-[11px] text-fg-dim">
						Calls carry no cookies and no <code className="font-mono">Authorization</code> header, so a method behind
						auth answers 401 — which is a real result shown as such, not a dashboard failure.
					</p>
				</CardContent>
			</Card>

			{error && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Cannot reach the Dashboard API</CardTitle>
						<CardDescription>
							The method list could not be read. Start the dashboard via <code>npm run dashboard</code> so the session
							token is set. ({String(error)})
						</CardDescription>
					</CardHeader>
				</Card>
			)}

			{isLoading && !methodsData && <p className="text-sm text-fg-soft">Reading the method catalogue…</p>}

			{methodsData && (
				<RpcMethodPicker
					namespaces={namespaces}
					source={methodsData.methodsSource}
					methodsError={methodsData.methodsError}
					selected={selected}
					onSelect={(ref) => {
						setSelected(ref);
						setReplay(undefined);
					}}
				/>
			)}

			{methodsData && namespaces.length > 0 && selectedMethod === undefined && (
				<Card>
					<CardHeader className="py-4">
						<CardTitle className="text-base">Pick a method to call it</CardTitle>
						<CardDescription>
							Choosing one above builds a form from its real parameter names and shows the exact JSON-RPC payload
							before anything is sent.
						</CardDescription>
					</CardHeader>
				</Card>
			)}

			{selected && selectedMethod && (
				<RpcInvoker
					// Keyed on the method (and on a replay) so switching methods
					// re-seeds the fields instead of carrying the previous call's
					// values into a different signature.
					key={`${qualifiedName(selected)}:${replay?.nonce ?? 'fresh'}`}
					namespace={selected.namespace}
					method={selectedMethod}
					stage={wireStageFor(target)}
					mode={target.mode}
					initialFields={replay?.fields}
					onCompleted={recordCall}
				/>
			)}

			{history.length > 0 && (
				<Card>
					<CardHeader className="py-3">
						<CardTitle className="flex items-center gap-2 text-base">
							<History size={14} strokeWidth={2} className="text-fg-dim" aria-hidden="true" />
							This session's calls
						</CardTitle>
						<CardDescription>
							The last {HISTORY_LIMIT} calls, newest first — expand one to re-read its result, or reuse its parameters
							instead of retyping them. Held in memory only: a reload clears it.
						</CardDescription>
					</CardHeader>
					<CardContent className="p-0">
						{history.map((call) => (
							<HistoryRow
								key={call.id}
								call={call}
								expanded={expandedCall === call.id}
								onToggle={() => setExpandedCall(expandedCall === call.id ? undefined : call.id)}
								onReuse={() => reuse(call)}
							/>
						))}
					</CardContent>
				</Card>
			)}
		</div>
	);
}
