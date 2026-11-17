// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { CircleAlert, FileJson, Info, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { RpcMethodsResponse, RpcNamespace } from '@/contract/v1';

/**
 * The method catalogue, as the playground reads it.
 *
 * These view types deliberately RE-DECLARE the contract's `ApiMethod` /
 * `ApiMethodParam` rather than importing them, and every field the catalogue
 * adds beyond the names is typed `unknown`.
 *
 * Two reasons. First, `@/contract/*` resolves to `dist/`, so a field the server
 * side adds is only visible here after a build — a form that reads `seed` must
 * not fail to compile in the window before that. Second, `unknown` accepts any
 * shape the addition eventually lands with, so this file cannot be broken by
 * the exact type someone else chooses for `seed`, `schema` or the spec-only
 * flag. Everything is narrowed at runtime below, where an absent field simply
 * means "that enrichment is not available yet" rather than an error.
 *
 * `RpcNamespace` (hence `ApiMethod`) is assignable to these, which is what
 * keeps the API-response path type-checked end to end.
 */
export interface PlaygroundParam {
	name: string;
	/** TypeScript type text when the spec resolved one. */
	type?: string;
	optional?: boolean;
	/** Spec-derived: whether the schema marks this parameter required. */
	required?: unknown;
	/** Spec-derived JSON Schema, when a spec covered this method. */
	schema?: unknown;
	/** Spec-derived starting value — a starting point, never a default. */
	seedValue?: unknown;
	/** How the seed was derived: an enum member, the schema's type, or nothing. */
	seedSource?: unknown;
	/** Set when a `$ref` in the schema could not be resolved. */
	schemaWarning?: unknown;
}

export interface PlaygroundMethod {
	name: string;
	params: PlaygroundParam[];
	/** `'source' | 'source+spec' | 'spec-only'` — which side listed the method. */
	origin?: unknown;
	/** Alternative spellings of the spec-only signal; read defensively. */
	specOnly?: unknown;
	source?: unknown;
}

export interface PlaygroundNamespace {
	namespace: string;
	/**
	 * Optional, matching the contract: a namespace returned by a factory method
	 * (`auth.createApi()`) is real and callable but has no `new ApiNamespace(...)`
	 * for a source scan to attribute it to. Such a namespace is listed with its
	 * origin left unstated rather than dropped.
	 */
	blockFullId?: string;
	methods: PlaygroundMethod[];
}

/** Identifies one method across the page, the invoker and the call history. */
export interface MethodRef {
	namespace: string;
	method: string;
}

/** `namespace.method` — the name the JSON-RPC envelope carries. */
export function qualifiedName(ref: MethodRef): string {
	return `${ref.namespace}.${ref.method}`;
}

/**
 * Whether a method exists only in the generated spec.
 *
 * The catalogue unions the app's source with the spec, so this means the SPEC is
 * stale rather than that the method is fake — the opposite conclusion, and the
 * one that points at the fix. Several field spellings are probed because the
 * flag is set on the server side; an unrecognised spelling costs the badge, not
 * the method.
 */
export function isSpecOnly(method: PlaygroundMethod): boolean {
	return method.origin === 'spec-only' || method.specOnly === true || method.source === 'spec-only';
}

/**
 * The seed for a parameter's field, and whether there is one at all.
 *
 * `seedValue` is what the catalogue writes; `seed` is accepted as an alternative
 * spelling. A seed of `null` is a real seed (the catalogue uses it when nothing
 * honest was derivable from the schema), so absence is tested on the property
 * rather than on the value.
 */
export function paramSeed(param: PlaygroundParam): { present: boolean; text: string } {
	const value = 'seedValue' in param ? param.seedValue : (param as { seed?: unknown }).seed;
	if (value === undefined) return { present: false, text: '' };
	try {
		return { present: true, text: JSON.stringify(value) };
	} catch {
		return { present: false, text: '' };
	}
}

/** `(userId, todoId)` — the real parameter names, which is the point of all this. */
export function formatSignature(method: PlaygroundMethod): string {
	if (method.params.length === 0) return '()';
	return `(${method.params.map((param) => param.name).join(', ')})`;
}

/** The type text to show beside a parameter, or undefined when only its name is known. */
export function paramTypeText(param: PlaygroundParam): string | undefined {
	if (typeof param.type === 'string' && param.type.length > 0) return param.type;
	const schema = param.schema;
	if (typeof schema === 'object' && schema !== null) {
		const type = (schema as Record<string, unknown>).type;
		if (typeof type === 'string') return type;
	}
	return undefined;
}

type MethodsSource = RpcMethodsResponse['methodsSource'];

const SOURCE_BADGE: Record<MethodsSource, { label: string; variant: 'success' | 'outline' | 'warning' }> = {
	spec: { label: 'typed · from blocks.spec.json', variant: 'success' },
	'source-scan': { label: 'names only · from your source', variant: 'outline' },
	unavailable: { label: 'no API declared', variant: 'warning' },
};

/**
 * Where the method list came from, stated rather than implied.
 *
 * `source-scan` is the ordinary case — almost no app has run the spec
 * generator — so it reads as a capability that is not switched on, never as a
 * failure. The distinction that matters is that the parameter NAMES are real
 * either way: they come from the app's own source, which is why the forms below
 * say `userId` instead of `arg0`.
 */
export function MethodsSourceNotice({
	source,
	methodsError,
	namespaceCount,
	methodCount,
}: {
	source: MethodsSource;
	methodsError?: string;
	namespaceCount: number;
	methodCount: number;
}) {
	const badge = SOURCE_BADGE[source];
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-start gap-2 rounded-md border border-line bg-hover px-3 py-2 text-xs">
				<Badge variant={badge.variant}>{badge.label}</Badge>
				<div className="max-w-3xl space-y-1 text-fg-soft">
					{source === 'spec' && (
						<p>
							<code className="font-mono">aws-blocks/blocks.spec.json</code> covers these methods, so each parameter
							below carries its type and a seed value derived from its schema. Parameter names still come from your
							app's source.
						</p>
					)}
					{source === 'source-scan' && (
						<>
							<p>
								Parameter <span className="font-medium text-fg">names</span> were read from your app's own source, so
								they are the real ones — <code className="font-mono">(userId, todoId)</code>, not{' '}
								<code className="font-mono">(arg0, arg1)</code>. Their <span className="font-medium text-fg">types
								</span>{' '}
								are unknown, which is why every field below is entered as JSON.
							</p>
							<p className="text-fg-dim">
								This is the normal state, not a problem. Run{' '}
								<code className="font-mono text-fg-soft">npx blocks-generate-spec</code> to write{' '}
								<code className="font-mono">aws-blocks/blocks.spec.json</code> from your backend's Zod schemas, and
								these forms come back typed and pre-seeded.
							</p>
						</>
					)}
					{source === 'unavailable' && (
						<p>
							This app declares no <code className="font-mono">ApiNamespace</code> block, so there is nothing to call —
							the list is empty because there are no methods, not because discovery failed. Declare an{' '}
							<code className="font-mono">ApiNamespace</code> under <code className="font-mono">aws-blocks/</code> and
							its methods appear here.
						</p>
					)}
					{source !== 'unavailable' && (
						<p className="text-fg-dim">
							{methodCount} method{methodCount === 1 ? '' : 's'} across {namespaceCount} namespace
							{namespaceCount === 1 ? '' : 's'}.
						</p>
					)}
				</div>
			</div>

			{/* Alongside the list, never instead of it: a stale or malformed spec
			    leaves every source-scanned method perfectly callable, and hiding
			    them would turn a downgrade in type detail into an outage. */}
			{methodsError && (
				<div className="flex items-start gap-2 rounded-md border border-warn/25 bg-warn/5 px-3 py-2 text-xs">
					<CircleAlert size={13} strokeWidth={2.1} className="mt-px shrink-0 text-warn-fg" aria-hidden="true" />
					<div className="max-w-3xl space-y-1">
						<p className="font-medium text-fg">The generated spec could not be used</p>
						<p className="text-fg-soft">
							The methods below are still the ones your app declares and are still callable — only the type
							information from the spec is missing. Fix or regenerate the spec to get typed forms back.
						</p>
						<p className="font-mono text-[11px] text-fg-dim">{methodsError}</p>
					</div>
				</div>
			)}
		</div>
	);
}

/** One selectable method row. */
function MethodRow({
	namespace,
	method,
	selected,
	onSelect,
}: {
	namespace: string;
	method: PlaygroundMethod;
	selected: boolean;
	onSelect: () => void;
}) {
	const stale = isSpecOnly(method);
	return (
		<button
			type="button"
			onClick={onSelect}
			aria-pressed={selected}
			className={`flex w-full flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
				selected ? 'bg-active text-fg' : 'text-fg-soft hover:bg-hover hover:text-fg'
			}`}
		>
			<span className="font-mono">
				<span className={selected ? 'text-fg' : 'text-fg-soft'}>{method.name}</span>
				<span className="text-fg-dim">{formatSignature(method)}</span>
			</span>
			{method.params.length === 0 && <span className="text-[11px] text-fg-dim">no parameters</span>}
			{stale && (
				<Badge
					variant="warning"
					title={`${namespace}.${method.name} is in the generated spec but not in your app's source. The spec is probably stale — regenerate it, or the call will be rejected as an unknown method.`}
				>
					likely stale
				</Badge>
			)}
		</button>
	);
}

export interface RpcMethodPickerProps {
	namespaces: PlaygroundNamespace[];
	source: MethodsSource;
	methodsError?: string;
	selected?: MethodRef;
	onSelect: (ref: MethodRef) => void;
}

/**
 * The namespace/method list, filterable by name.
 *
 * The filter matches the qualified name AND the parameter names, because
 * "which method takes a todoId" is a question a developer actually has and the
 * names are real enough to answer it.
 */
export function RpcMethodPicker({ namespaces, source, methodsError, selected, onSelect }: RpcMethodPickerProps) {
	const [filter, setFilter] = useState('');

	const methodCount = useMemo(
		() => namespaces.reduce((total, namespace) => total + namespace.methods.length, 0),
		[namespaces],
	);

	const filtered = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		if (needle.length === 0) return namespaces;
		return namespaces
			.map((namespace) => ({
				...namespace,
				methods: namespace.methods.filter((method) => {
					const haystack = [
						`${namespace.namespace}.${method.name}`,
						...method.params.map((param) => param.name),
					]
						.join(' ')
						.toLowerCase();
					return haystack.includes(needle);
				}),
			}))
			.filter((namespace) => namespace.methods.length > 0);
	}, [namespaces, filter]);

	const hidden = methodCount - filtered.reduce((total, namespace) => total + namespace.methods.length, 0);

	return (
		<Card>
			<CardHeader className="py-3">
				<CardTitle className="text-base">Methods</CardTitle>
				<CardDescription>
					Every callable method this app declares, with the parameter names it actually uses.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				<MethodsSourceNotice
					source={source}
					methodsError={methodsError}
					namespaceCount={namespaces.length}
					methodCount={methodCount}
				/>

				{methodCount > 0 && (
					<label className="flex items-center gap-2 rounded-md border border-line bg-bg px-2.5 py-1.5">
						<Search size={13} strokeWidth={2} className="shrink-0 text-fg-dim" aria-hidden="true" />
						<span className="sr-only">Filter methods by name or parameter name</span>
						<input
							type="text"
							value={filter}
							onChange={(event) => setFilter(event.target.value)}
							placeholder="Filter by method or parameter name…"
							spellCheck={false}
							className="w-full bg-transparent font-mono text-xs text-fg outline-none placeholder:text-fg-dim"
						/>
					</label>
				)}

				{filtered.map((namespace) => (
					<div key={namespace.namespace} className="space-y-1">
						<div className="flex flex-wrap items-baseline gap-2 px-0.5">
							<span className="font-mono text-[13px] font-medium text-fg">{namespace.namespace}</span>
							{namespace.blockFullId ? (
								<span
									className="font-mono text-[11px] text-fg-dim"
									title="The ApiNamespace block this namespace comes from."
								>
									{namespace.blockFullId}
								</span>
							) : (
								<span
									className="text-[11px] text-fg-dim"
									title="No ApiNamespace declaration was found for this namespace — a namespace returned by a factory method (auth.createApi()) is callable but invisible to a source scan. It is listed because it answers real calls."
								>
									no declaring block found
								</span>
							)}
						</div>
						<div className="space-y-0.5">
							{namespace.methods.map((method) => (
								<MethodRow
									key={method.name}
									namespace={namespace.namespace}
									method={method}
									selected={
										selected?.namespace === namespace.namespace && selected?.method === method.name
									}
									onSelect={() => onSelect({ namespace: namespace.namespace, method: method.name })}
								/>
							))}
						</div>
					</div>
				))}

				{methodCount > 0 && filtered.length === 0 && (
					<p className="flex items-center gap-2 px-0.5 text-xs text-fg-dim">
						<Info size={13} strokeWidth={2.1} aria-hidden="true" />
						No method or parameter name matches “{filter}”. {methodCount} method
						{methodCount === 1 ? ' is' : 's are'} available — clear the filter to see {methodCount === 1 ? 'it' : 'them'}
						.
					</p>
				)}

				{hidden > 0 && filtered.length > 0 && (
					<p className="px-0.5 text-[11px] text-fg-dim">
						{hidden} method{hidden === 1 ? '' : 's'} hidden by the filter.
					</p>
				)}

				{source === 'spec' && (
					<p className="flex items-center gap-1.5 px-0.5 text-[11px] text-fg-dim">
						<FileJson size={12} strokeWidth={2} aria-hidden="true" />
						Types and seed values come from the generated spec; names come from your source.
					</p>
				)}
			</CardContent>
		</Card>
	);
}

/** Narrows an `RpcNamespace[]` from the API onto the picker's view type. */
export function asPlaygroundNamespaces(namespaces: RpcNamespace[]): PlaygroundNamespace[] {
	return namespaces;
}
