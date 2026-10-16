// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useMutation } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, Info, Send, ShieldAlert, Unplug } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { JsonView } from '@/components/json-view';
import {
	type PlaygroundMethod,
	type PlaygroundParam,
	formatSignature,
	paramSeed,
	paramTypeText,
	qualifiedName,
} from '@/components/rpc-method-picker';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { DataMode, RpcInvokeRequest, RpcInvokeResponse } from '@/contract/v1';
import { apiMutate } from '@/lib/api-mutate';

/**
 * A JSON-RPC error as the invoker reads it.
 *
 * `kind` and `retriable` are typed `unknown` for the same reason the picker's
 * view types are: they are produced server-side and `@/contract/*` resolves to
 * `dist/`, so this file must compile whether or not that build has happened
 * yet, and whatever exact type they land with. Both are narrowed at runtime,
 * and `kind` has a code-range fallback so the application/protocol split works
 * even when the field is absent.
 */
export interface PlaygroundRpcError {
	code?: number;
	message: string;
	name?: string;
	kind?: unknown;
	retriable?: unknown;
}

/** `RpcInvokeResponse` with the widened error. The contract type is assignable to it. */
export type PlaygroundInvokeResponse = Omit<RpcInvokeResponse, 'rpcError'> & { rpcError?: PlaygroundRpcError };

/** One call made this session. Kept in memory by the page, never persisted. */
export interface PlaygroundCall {
	/** Monotonic within the session; also the React key. */
	id: number;
	namespace: string;
	method: string;
	mode: DataMode;
	stage: string;
	/** The exact field text, so a replay restores what was typed. */
	fields: string[];
	/** The positional array that went on the wire. */
	params: unknown[];
	result: PlaygroundInvokeResponse;
}

const PRIMARY_BUTTON =
	'flex items-center gap-1.5 rounded-md bg-active px-2.5 py-1 text-xs font-medium text-fg transition-colors hover:bg-line disabled:cursor-not-allowed disabled:text-fg-dim disabled:hover:bg-active';
const QUIET_BUTTON =
	'rounded-md border border-line px-2.5 py-1 text-xs text-fg-soft transition-colors hover:bg-active hover:text-fg disabled:cursor-not-allowed disabled:text-fg-dim';
const DANGER_BUTTON =
	'flex items-center gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger-fg-strong transition-colors hover:bg-danger/20 disabled:cursor-not-allowed disabled:border-line-soft disabled:bg-transparent disabled:text-fg-dim';

/** Production-shaped stage names get the most deliberate confirmation. */
export function isProductionStage(stage: string): boolean {
	return /prod/i.test(stage);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	return value as Record<string, unknown>;
}

/**
 * The starting text for a parameter's field.
 *
 * A spec-derived seed is used when there is one; otherwise the field starts
 * empty rather than guessing, because an invented value that looks official is
 * worse than a blank the user must fill in.
 */
export function seedFieldText(param: PlaygroundParam): string {
	return paramSeed(param).text;
}

export interface FieldParse {
	ok: boolean;
	value?: unknown;
	reason?: string;
}

/** Each field is JSON so any type is expressible — including null and objects. */
export function parseField(text: string): FieldParse {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return { ok: false, reason: 'is empty — enter a JSON value (use null if the method expects nothing there)' };
	}
	try {
		return { ok: true, value: JSON.parse(trimmed) };
	} catch (error) {
		return { ok: false, reason: `is not valid JSON yet — ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * The server labels every JSON-RPC error with a `kind`; this is the fallback for
 * a payload that predates that field, and it uses the same rule the server does
 * — a positive code is the app's own HTTP-style status, anything else (a
 * JSON-RPC reserved negative code, or no code at all) is protocol level — so the
 * two can never disagree about the same error.
 */
function classifyRpcError(rpcError: PlaygroundRpcError): 'application' | 'protocol' {
	if (rpcError.kind === 'protocol') return 'protocol';
	if (rpcError.kind === 'application') return 'application';
	return typeof rpcError.code === 'number' && rpcError.code > 0 ? 'application' : 'protocol';
}

export type Outcome = 'success' | 'application' | 'protocol' | 'transport' | 'http';

/**
 * Which of the outcomes a result is. They are kept apart because each one leads
 * somewhere different: fix your input, fix the method name, start the server,
 * or read the answer.
 */
export function classifyOutcome(result: PlaygroundInvokeResponse): Outcome {
	if (result.transportErrorCode) return 'transport';
	if (result.rpcError) return classifyRpcError(result.rpcError);
	if (result.httpStatus < 200 || result.httpStatus > 299) return 'http';
	return 'success';
}

const TRANSPORT_TITLE: Record<NonNullable<RpcInvokeResponse['transportErrorCode']>, string> = {
	TIMEOUT: 'The app did not answer in time',
	UNREACHABLE: 'Nothing answered at that endpoint',
	NO_ENDPOINT: 'There is no endpoint to call',
	BAD_METHOD: 'The call was never sent',
};

/** Always-visible provenance: which environment answered, and how fast. */
function ResultMeta({ result }: { result: PlaygroundInvokeResponse }) {
	return (
		<dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[11px]">
			<div className="flex items-baseline gap-1.5">
				<dt className="text-fg-dim">endpoint</dt>
				<dd className="break-all font-mono text-fg-soft">
					{result.endpoint || <span className="text-fg-dim">none resolved</span>}
				</dd>
			</div>
			<div className="flex items-baseline gap-1.5">
				<dt className="text-fg-dim">status</dt>
				<dd className="font-mono text-fg-soft">
					{result.httpStatus === 0 ? (
						<span title="No HTTP response was received at all, so there is no status to report. It is 0 rather than a status we made up.">
							0 · no response
						</span>
					) : (
						result.httpStatus
					)}
				</dd>
			</div>
			<div className="flex items-baseline gap-1.5">
				<dt className="text-fg-dim">took</dt>
				<dd className="font-mono text-fg-soft">{result.durationMs} ms</dd>
			</div>
			<div className="flex items-baseline gap-1.5">
				<dt className="text-fg-dim">from</dt>
				<dd className="font-mono text-fg-soft">
					{result.mode === 'cloud' ? `cloud · ${result.stage}` : 'local'}
				</dd>
			</div>
		</dl>
	);
}

/**
 * A body that did not parse as JSON, rendered as the text it was.
 *
 * That text is usually the whole diagnosis — an API Gateway error page, a
 * proxy's plain-text 502 — so it is shown verbatim instead of as an empty
 * object.
 */
function NonJsonBody({ text, contentType }: { text: string; contentType?: string }) {
	return (
		<div className="space-y-1.5">
			<div className="flex flex-wrap items-center gap-2 text-[11px]">
				<Badge variant="outline">not JSON</Badge>
				<span className="text-fg-soft">
					The response body is not JSON{contentType ? ' — it arrived as ' : ''}
					{contentType && <code className="font-mono text-fg-soft">{contentType}</code>}. It is shown as text because
					that text is the diagnosis.
				</span>
			</div>
			<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-bg px-2.5 py-2 font-mono text-[11px] leading-relaxed text-fg-soft">
				{text}
			</pre>
		</div>
	);
}

/** The body, as JSON tree or as text, whichever it actually is. */
function ResultBody({ value, rootName }: { value: unknown; rootName: string }) {
	const record = asRecord(value);
	const nonJson = record?.nonJsonBody;
	if (typeof nonJson === 'string') {
		const contentType = record?.contentType;
		return <NonJsonBody text={nonJson} contentType={typeof contentType === 'string' ? contentType : undefined} />;
	}
	return <JsonView value={value} rootName={rootName} />;
}

export interface RpcResultViewProps {
	result: PlaygroundInvokeResponse;
	method: string;
}

/**
 * One result, rendered as whichever of the outcomes it is.
 *
 * The colour is part of the message. An application error is the app's own
 * logic answering correctly — it gets a neutral, informational surface, because
 * dressing it in red would blame the dashboard for a 404 the app meant to
 * return. Red is reserved for the call not completing.
 */
export function RpcResultView({ result, method }: RpcResultViewProps) {
	const outcome = classifyOutcome(result);
	const body = asRecord(result.body);
	const hasResultKey = body !== undefined && 'result' in body;

	if (outcome === 'success') {
		return (
			<div className="space-y-2 rounded-md border border-ok/25 bg-ok/5 px-3 py-2.5">
				<div className="flex flex-wrap items-center gap-2">
					<CircleCheck size={14} strokeWidth={2.1} className="shrink-0 text-ok-fg" aria-hidden="true" />
					<span className="text-[13px] font-medium text-fg">
						<code className="font-mono">{method}</code> returned a result
					</span>
					<Badge variant="success">success</Badge>
				</div>
				<ResultMeta result={result} />
				<div className="rounded-md border border-line bg-bg px-2.5 py-2">
					<ResultBody value={hasResultKey ? body?.result : result.body} rootName="result" />
				</div>
				{!hasResultKey && (
					<p className="text-[11px] text-fg-dim">
						The payload carried no <code className="font-mono">result</code> field, so the whole response body is shown.
					</p>
				)}
			</div>
		);
	}

	if (outcome === 'application') {
		const rpcError = result.rpcError as PlaygroundRpcError;
		const retriable = rpcError.retriable;
		return (
			<div className="space-y-2 rounded-md border border-brand/25 bg-brand/5 px-3 py-2.5">
				<div className="flex flex-wrap items-center gap-2">
					<Info size={14} strokeWidth={2.1} className="shrink-0 text-brand" aria-hidden="true" />
					<span className="text-[13px] font-medium text-fg">Your app answered with an error</span>
					<Badge variant="outline">application error</Badge>
					{rpcError.name && <Badge variant="outline">{rpcError.name}</Badge>}
				</div>
				<p className="max-w-3xl text-xs text-fg-soft">
					The call reached <code className="font-mono">{method}</code> and your app's own logic turned it down. That is a
					working round trip and a real answer — nothing in the dashboard failed, and nothing about the endpoint needs
					fixing.
				</p>
				<div className="space-y-1 rounded-md border border-line bg-bg px-2.5 py-2 text-xs">
					<p className="text-fg">{rpcError.message}</p>
					<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[11px] text-fg-dim">
						{rpcError.code !== undefined && (
							<span title="Application errors carry an HTTP-style status in the JSON-RPC code — 404 for not found, 403 for forbidden — rather than a JSON-RPC reserved code.">
								code <span className="font-mono text-fg-soft">{rpcError.code}</span> · an HTTP-style status
							</span>
						)}
						{rpcError.name !== undefined && (
							<span>
								name <span className="font-mono text-fg-soft">{rpcError.name}</span>
							</span>
						)}
						{typeof retriable === 'boolean' && (
							<span>
								{retriable
									? 'marked retriable — the same call may succeed if you send it again'
									: 'marked not retriable — re-sending the same call will not change the answer'}
							</span>
						)}
					</div>
				</div>
				<ResultMeta result={result} />
				<details className="text-[11px]">
					<summary className="cursor-pointer text-fg-dim hover:text-fg-soft">Full response body</summary>
					<div className="mt-1.5 rounded-md border border-line bg-bg px-2.5 py-2">
						<ResultBody value={result.body} rootName="body" />
					</div>
				</details>
			</div>
		);
	}

	if (outcome === 'protocol') {
		const rpcError = result.rpcError as PlaygroundRpcError;
		return (
			<div className="space-y-2 rounded-md border border-warn/25 bg-warn/5 px-3 py-2.5">
				<div className="flex flex-wrap items-center gap-2">
					<CircleAlert size={14} strokeWidth={2.1} className="shrink-0 text-warn-fg" aria-hidden="true" />
					<span className="text-[13px] font-medium text-fg">The call was not dispatched</span>
					<Badge variant="warning">protocol error</Badge>
				</div>
				<p className="max-w-3xl text-xs text-fg-soft">
					Your app received the request but never ran <code className="font-mono">{method}</code> — the JSON-RPC layer
					rejected it first. Check the method name against the list (a method flagged{' '}
					<span className="font-medium text-fg">likely stale</span> is in the spec but not in your source), and check that
					you sent as many parameters as it declares, in order.
				</p>
				<div className="space-y-1 rounded-md border border-line bg-bg px-2.5 py-2 text-xs">
					<p className="text-fg">{rpcError.message}</p>
					{rpcError.code !== undefined && (
						<p className="text-[11px] text-fg-dim">
							code <span className="font-mono text-fg-soft">{rpcError.code}</span> · a JSON-RPC reserved code, not an
							HTTP status
						</p>
					)}
				</div>
				<ResultMeta result={result} />
			</div>
		);
	}

	if (outcome === 'http') {
		return (
			<div className="space-y-2 rounded-md border border-warn/25 bg-warn/5 px-3 py-2.5">
				<div className="flex flex-wrap items-center gap-2">
					<CircleAlert size={14} strokeWidth={2.1} className="shrink-0 text-warn-fg" aria-hidden="true" />
					<span className="text-[13px] font-medium text-fg">The endpoint answered HTTP {result.httpStatus}</span>
					<Badge variant="outline">upstream status</Badge>
				</div>
				<p className="max-w-3xl text-xs text-fg-soft">
					The request arrived somewhere and got an HTTP {result.httpStatus} back, with no JSON-RPC envelope in it. That
					status is reported exactly as it was sent — a {result.httpStatus === 401 || result.httpStatus === 403 ? 'refusal from your app’s own auth' : 'status from your app or the infrastructure in front of it'}{' '}
					is a real, inspectable answer rather than a dashboard failure. The dashboard sends no cookies or credentials, so
					an auth-gated method is expected to answer this way.
				</p>
				<ResultMeta result={result} />
				<div className="rounded-md border border-line bg-bg px-2.5 py-2">
					<ResultBody value={result.body} rootName="body" />
				</div>
			</div>
		);
	}

	const code = result.transportErrorCode ?? 'UNREACHABLE';
	return (
		<div className="space-y-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2.5">
			<div className="flex flex-wrap items-center gap-2">
				<Unplug size={14} strokeWidth={2.1} className="shrink-0 text-danger-fg" aria-hidden="true" />
				<span className="text-[13px] font-medium text-fg">{TRANSPORT_TITLE[code]}</span>
				<Badge variant="destructive">{code}</Badge>
			</div>
			<div className="max-w-3xl space-y-1.5 text-xs text-fg-soft">
				{code === 'TIMEOUT' && (
					<p>
						The connection was made and then nothing came back before the deadline. Your app is slow or hung on this
						call rather than absent — check its logs for <code className="font-mono">{method}</code>, and look for a
						long query or an await that never settles. Re-sending will most likely time out the same way.
					</p>
				)}
				{code === 'UNREACHABLE' && (
					<p>
						{result.mode === 'local' ? (
							<>
								Nothing is listening on the local endpoint, which usually means the app's dev server is not running.
								Start it (<code className="font-mono">npm run dev</code> in your app), then send again. This is a
								different situation from a timeout: nothing accepted the connection at all.
							</>
						) : (
							<>
								The connection could not be established at all — DNS, the network, or a stack that no longer serves
								this URL. Nothing accepted the request, which is why there is no status above.
							</>
						)}
					</p>
				)}
				{code === 'NO_ENDPOINT' && (
					<p>
						There is no URL to call for this stage and mode, so no request was attempted.{' '}
						{result.mode === 'cloud' ? (
							<>
								In cloud mode the endpoint comes from the deployed stack's <code className="font-mono">ApiUrl</code>{' '}
								output, so this usually means <span className="font-medium text-fg">{result.stage}</span> is not
								deployed yet. Deploy it, or switch to local mode to call the dev server instead.
							</>
						) : (
							<>The local endpoint could not be worked out from the project on disk.</>
						)}
					</p>
				)}
				{code === 'BAD_METHOD' && (
					<p>
						The method name was rejected before anything was sent, so no request left this machine and nothing was
						changed. <code className="font-mono">{method}</code> is not a well-formed{' '}
						<code className="font-mono">namespace.method</code> name — pick the method from the list rather than typing
						it.
					</p>
				)}
			</div>
			<ResultMeta result={result} />
			{/* A BAD_METHOD result carries the codec's exact complaint as well as
			    the code; showing it saves guessing which part of the name was
			    rejected. */}
			{result.rpcError?.message && (
				<p className="rounded-md border border-line bg-bg px-2.5 py-2 font-mono text-[11px] text-fg-soft">
					{result.rpcError.message}
				</p>
			)}
			{result.body !== undefined && result.body !== null && (
				<div className="rounded-md border border-line bg-bg px-2.5 py-2">
					<ResultBody value={result.body} rootName="detail" />
				</div>
			)}
		</div>
	);
}

export interface RpcInvokerProps {
	namespace: string;
	method: PlaygroundMethod;
	stage: string;
	mode: DataMode;
	/** Restores the fields of an earlier call, for a replay. */
	initialFields?: string[];
	/** Called with every completed call, for the session history. */
	onCompleted: (call: Omit<PlaygroundCall, 'id'>) => void;
}

/**
 * The form for one method: a field per parameter, the exact wire payload, and
 * the result.
 *
 * Parameters are POSITIONAL — that is the JSON-RPC wire format — so the array
 * is built in declared order and shown before it is sent. A playground whose
 * payload you cannot see is just a slower client.
 */
export function RpcInvoker({ namespace, method, stage, mode, initialFields, onCompleted }: RpcInvokerProps) {
	const qualified = qualifiedName({ namespace, method: method.name });
	const production = isProductionStage(stage);

	const [fields, setFields] = useState<string[]>(
		() => initialFields ?? method.params.map((param) => seedFieldText(param)),
	);
	const [confirming, setConfirming] = useState(false);
	const [productionAck, setProductionAck] = useState('');
	const alertId = useId();
	const ackId = useId();

	const parsed = useMemo(() => fields.map((text) => parseField(text)), [fields]);
	const offending = method.params
		.map((param, index) => ({ name: param.name, index, parse: parsed[index] }))
		.filter((entry) => entry.parse && !entry.parse.ok);
	const valid = offending.length === 0;
	const params = valid ? parsed.map((entry) => entry.value) : [];

	// A confirmation is per call AND per target, so switching local/cloud drops a
	// half-finished one rather than carrying consent from one environment to
	// another. The typed parameters deliberately survive the switch — comparing
	// the same call against local and cloud is the point of having both.
	useEffect(() => {
		setConfirming(false);
		setProductionAck('');
	}, [mode, stage]);

	const seeded = method.params.some((param) => paramSeed(param).present);

	const mutation = useMutation({
		mutationFn: (positional: unknown[]) =>
			apiMutate<PlaygroundInvokeResponse>('/api/v1/rpc', 'POST', {
				stage,
				mode,
				method: qualified,
				params: positional,
			} satisfies RpcInvokeRequest),
		onSuccess: (result) => {
			// A per-call confirmation means per call: the next cloud send asks again.
			setConfirming(false);
			setProductionAck('');
			onCompleted({
				namespace,
				method: method.name,
				mode,
				stage,
				fields: [...fields],
				params: [...params],
				result,
			});
		},
	});

	const setField = (index: number, text: string) => {
		setFields((current) => current.map((existing, position) => (position === index ? text : existing)));
	};

	const send = () => {
		if (!valid || mutation.isPending) return;
		mutation.mutate(params);
	};

	const ackSatisfied = !production || productionAck.trim() === stage;
	const payloadText = valid ? JSON.stringify(params, null, 2) : '[ … fix the parameter below … ]';

	return (
		<Card>
			<CardHeader className="py-3">
				<CardTitle className="font-mono text-base">
					{qualified}
					<span className="text-fg-dim">{formatSignature(method)}</span>
				</CardTitle>
				<CardDescription>
					{method.params.length === 0
						? 'This method takes no parameters, so the call sends an empty array.'
						: `${method.params.length} positional parameter${
								method.params.length === 1 ? '' : 's'
							}, in the order your app declares them. Each is entered as JSON so any type is expressible.`}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				{method.params.length > 0 && (
					<div className="space-y-2">
						{method.params.map((param, index) => {
							const type = paramTypeText(param);
							const parse = parsed[index];
							const bad = parse !== undefined && !parse.ok;
							return (
								<label key={param.name} className="block space-y-1">
									<span className="flex flex-wrap items-baseline gap-2">
										<span className="font-mono text-xs text-fg">{param.name}</span>
										{type ? (
											<span className="font-mono text-[11px] text-fg-dim">{type}</span>
										) : (
											<span
												className="text-[11px] text-fg-dim"
												title="No type information is available for this parameter — the generated spec would supply it."
											>
												type unknown
											</span>
										)}
										{(param.optional === true || param.required === false) && (
											<span
												className="text-[11px] text-fg-dim"
												title="Declared optional. It is still positional, so a value sent here lands in this position regardless."
											>
												optional
											</span>
										)}
									</span>
									<input
										type="text"
										value={fields[index] ?? ''}
										onChange={(event) => setField(index, event.target.value)}
										spellCheck={false}
										aria-label={`${param.name} as JSON`}
										aria-invalid={bad}
										aria-describedby={alertId}
										placeholder='JSON value — "text", 42, true, null, {"a":1}'
										className={`w-full rounded-md border bg-bg px-2.5 py-1.5 font-mono text-xs text-fg outline-none placeholder:text-fg-dim ${
											bad ? 'border-warn/50' : 'border-line focus:border-brand/50'
										}`}
									/>
									{/* The catalogue leaves an unresolvable $ref in place rather
									    than inventing a type; saying so here is why this field
									    has no type beside it. */}
									{typeof param.schemaWarning === 'string' && param.schemaWarning.length > 0 && (
										<span className="block text-[11px] text-warn-fg/90">{param.schemaWarning}</span>
									)}
								</label>
							);
						})}

						{seeded && (
							<p className="text-[11px] text-fg-dim">
								Pre-filled values are <span className="font-medium text-fg-soft">starting points</span> derived from
								the generated spec's schemas — they are not defaults your API would apply, and nothing supplies them
								if you clear the field.
							</p>
						)}
					</div>
				)}

				{/* Empty while valid, so the alert fires on becoming invalid rather
				    than announcing a standing "all good" on every keystroke. */}
				<div id={alertId} role="alert" className="min-h-[1rem] text-xs">
					{!valid && (
						<span className="text-warn-fg">
							{offending.length === 1 ? 'Parameter ' : 'Parameters '}
							{offending.map((entry, position) => (
								<span key={entry.name}>
									{position > 0 && ', '}
									<code className="font-mono">{entry.name}</code>
								</span>
							))}{' '}
							{offending.length === 1 ? offending[0].parse?.reason : 'need valid JSON values'}. Send stays disabled
							until every field parses.
						</span>
					)}
				</div>

				<div className="space-y-1">
					<div className="flex flex-wrap items-baseline gap-2">
						<span className="text-xs text-fg-soft">Request that will be sent</span>
						<span className="text-[11px] text-fg-dim">
							method <code className="font-mono">{qualified}</code> · params are positional
						</span>
					</div>
					<pre className="max-h-48 overflow-auto rounded-md border border-line bg-bg px-2.5 py-2 font-mono text-[11px] leading-relaxed text-fg-soft">
						{payloadText}
					</pre>
				</div>

				{mode === 'local' && (
					<div className="flex flex-wrap items-center gap-3">
						<button type="button" onClick={send} disabled={!valid || mutation.isPending} className={PRIMARY_BUTTON}>
							<Send size={12} strokeWidth={2.2} aria-hidden="true" />
							{mutation.isPending ? 'Sending…' : 'Send'}
						</button>
						<span className="text-[11px] text-fg-dim">
							Goes to the dev server on this machine. Nothing deployed is touched.
						</span>
					</div>
				)}

				{mode === 'cloud' && !confirming && (
					<div className="flex flex-wrap items-center gap-3">
						<button
							type="button"
							onClick={() => setConfirming(true)}
							disabled={!valid || mutation.isPending}
							className={production ? DANGER_BUTTON : PRIMARY_BUTTON}
						>
							<Send size={12} strokeWidth={2.2} aria-hidden="true" />
							Send to {stage}…
						</button>
						<span className="text-[11px] text-fg-dim">
							Cloud calls are confirmed one at a time — the next one asks again.
						</span>
					</div>
				)}

				{/* The speed bump, and the only one: an RPC call goes through the
				    app's own auth, validation and business logic, so unlike a direct
				    store write it is not a privileged path and is not unlock-gated.
				    It can still change real data, which is what this confirms. */}
				{mode === 'cloud' && confirming && (
					<div
						className={`space-y-2 rounded-md border px-3 py-2.5 ${
							production ? 'border-danger/40 bg-danger/5' : 'border-warn/30 bg-warn/5'
						}`}
					>
						<div className="flex flex-wrap items-center gap-2">
							<ShieldAlert
								size={14}
								strokeWidth={2.1}
								className={`shrink-0 ${production ? 'text-danger-fg' : 'text-warn-fg'}`}
								aria-hidden="true"
							/>
							<span className="text-[13px] font-medium text-fg">
								{production ? 'This calls PRODUCTION' : 'Confirm this cloud call'}
							</span>
							<Badge variant={production ? 'destructive' : 'warning'}>
								{production ? `live production · ${stage}` : `cloud · ${stage}`}
							</Badge>
						</div>

						<p className="max-w-3xl text-xs text-fg-soft">
							Call <code className="font-mono text-fg">{qualified}</code> on the deployed{' '}
							<span className="font-medium text-fg">{stage}</span> stack
							{method.params.length > 0 ? ' with the parameters above' : ' with no parameters'}?{' '}
							{production ? (
								<>
									This runs against live production data through your app's real logic. If the method writes, it
									writes for real, and there is no staging copy and no undo.
								</>
							) : (
								<>
									It runs against the deployed stage rather than your machine, so if the method writes, it writes
									there.
								</>
							)}
						</p>

						{production && (
							<label className="block space-y-1">
								<span className="text-xs text-fg-soft">
									Type the stage name <code className="font-mono text-fg">{stage}</code> to enable the call
								</span>
								<input
									type="text"
									value={productionAck}
									onChange={(event) => setProductionAck(event.target.value)}
									spellCheck={false}
									autoComplete="off"
									aria-label={`Type ${stage} to confirm calling production`}
									aria-describedby={ackId}
									className="w-56 rounded-md border border-danger/40 bg-bg px-2.5 py-1.5 font-mono text-xs text-fg outline-none focus:border-danger/70"
								/>
								<span id={ackId} className="block text-[11px] text-fg-dim">
									A production call takes one more deliberate step than a sandbox one on purpose.
								</span>
							</label>
						)}

						<div className="flex flex-wrap items-center gap-2">
							<button
								type="button"
								onClick={send}
								disabled={!valid || !ackSatisfied || mutation.isPending}
								className={production ? DANGER_BUTTON : PRIMARY_BUTTON}
							>
								<Send size={12} strokeWidth={2.2} aria-hidden="true" />
								{mutation.isPending ? 'Sending…' : production ? `Call production ${stage}` : `Call ${stage}`}
							</button>
							<button
								type="button"
								onClick={() => {
									setConfirming(false);
									setProductionAck('');
								}}
								disabled={mutation.isPending}
								className={QUIET_BUTTON}
							>
								Cancel
							</button>
						</div>
					</div>
				)}

				{mutation.error && (
					<div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs">
						<p className="text-fg-soft">
							The request to the dashboard's own API failed: {String(mutation.error)}. That is this browser not
							reaching the dashboard — your app was never called, so nothing it owns was touched.
						</p>
					</div>
				)}

				{mutation.data && <RpcResultView result={mutation.data} method={qualified} />}
			</CardContent>
		</Card>
	);
}
