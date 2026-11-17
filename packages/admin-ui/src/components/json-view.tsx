// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { ChevronDown, ChevronRight, EyeOff } from 'lucide-react';
import { Fragment, useState } from 'react';

/**
 * The redaction marker, byte-for-byte as the server's redaction authority
 * writes it.
 *
 * Deliberately duplicated as a literal rather than imported from
 * `src/server/redact.ts`: that module carries the credential-shape patterns,
 * and pulling it into a client bundle would ship them to the browser for no
 * gain. The bullets are why the marker is not plain ASCII — a masked value has
 * to be unmistakable even in a raw copy-paste, before any styling applies.
 */
export const REDACTED_MARKER = '\u2022\u2022\u2022redacted\u2022\u2022\u2022';

/**
 * Why the bullets are there, on every masked value. Phrased as an explanation
 * of a deliberate act, not as an error: a user who reads bullets as data loss
 * files a bug against the store instead of trusting the dashboard.
 */
export const REDACTION_TITLE =
	'Masked before it left the server. This value matched a credential shape (password hash, API key, token, secret), so the dashboard replaced it on the way out — the real value never reached your browser. The stored record still holds it.';

/** Nodes at or below this depth start expanded; deeper ones start collapsed. */
const DEFAULT_EXPAND_DEPTH = 2;

/** Depth at which a one-line preview stops recursing and summarises instead. */
const PREVIEW_DEPTH = 2;

type Container = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is Container {
	return typeof value === 'object' && value !== null;
}

/** Array indices become string names so objects and arrays walk identically. */
function entriesOf(value: Container): [string, unknown][] {
	return Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
}

/** What a collapsed container says about itself: `{…} 5 keys` / `[…] 3 items`. */
function containerSummary(value: Container): string {
	if (Array.isArray(value)) {
		return `[…] ${value.length} item${value.length === 1 ? '' : 's'}`;
	}
	const count = Object.keys(value).length;
	return `{…} ${count} key${count === 1 ? '' : 's'}`;
}

function previewOf(value: unknown, depth: number): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'string') return value.includes(REDACTED_MARKER) ? value : JSON.stringify(value);
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (!isContainer(value)) return String(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		if (depth >= PREVIEW_DEPTH) return containerSummary(value);
		return `[${value.map((item) => previewOf(item, depth + 1)).join(', ')}]`;
	}
	const entries = Object.entries(value);
	if (entries.length === 0) return '{}';
	if (depth >= PREVIEW_DEPTH) return containerSummary(value);
	return `{ ${entries.map(([key, child]) => `${key}: ${previewOf(child, depth + 1)}`).join(', ')} }`;
}

/**
 * A single-line, width-bounded preview of an arbitrary value — what a table
 * cell shows before the reader expands it into the full tree.
 */
export function summarizeJson(value: unknown, maxLength = 96): string {
	const text = previewOf(value, 0);
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * A masked value. Distinguished from ordinary string content by four
 * independent cues — dashed border, tinted chip, icon, and the bullet
 * glyphs — so it does not read as data that happens to say "redacted".
 */
function RedactedMark() {
	return (
		<span
			title={REDACTION_TITLE}
			className="inline-flex items-center gap-1 rounded border border-dashed border-warn/40 bg-warn/10 px-1.5 py-px align-middle font-mono text-[11px] text-warn-fg"
		>
			<EyeOff size={10} strokeWidth={2.2} aria-hidden="true" />
			<span aria-hidden="true">{REDACTED_MARKER}</span>
			<span className="sr-only">redacted — a credential-shaped value was masked on the server</span>
		</span>
	);
}

/**
 * Strings are split on the marker rather than tested for equality: the server
 * masks a matching shape wherever it occurs, so a marker can sit inside
 * otherwise-ordinary text. Splitting keeps the surviving text readable.
 */
function StringLeaf({ value }: { value: string }) {
	if (!value.includes(REDACTED_MARKER)) {
		return (
			<span title="string" className="break-all text-brand">
				&quot;{value}&quot;
			</span>
		);
	}
	const parts = value.split(REDACTED_MARKER);
	return (
		<span title="string, partly masked">
			{parts.map((part, index) => (
				<Fragment key={`${index}-${part}`}>
					{index > 0 && <RedactedMark />}
					{part && <span className="break-all text-brand">{part}</span>}
				</Fragment>
			))}
		</span>
	);
}

/**
 * Type is carried by glyph and weight as well as colour — quotes for strings,
 * tabular digits for numbers, bold for booleans, italic for null — so the
 * distinction survives greyscale, colour-blindness, and a copy-paste.
 */
function Leaf({ value }: { value: unknown }) {
	if (typeof value === 'string') return <StringLeaf value={value} />;
	if (typeof value === 'number') {
		return (
			<span title="number" className="tabular-nums text-fg">
				{value}
			</span>
		);
	}
	if (typeof value === 'boolean') {
		return (
			<span title="boolean" className="font-semibold text-fg-soft">
				{String(value)}
			</span>
		);
	}
	if (value === null) {
		return (
			<span title="null" className="italic text-fg-dim">
				null
			</span>
		);
	}
	if (value === undefined) {
		return (
			<span title="undefined" className="italic text-fg-dim">
				undefined
			</span>
		);
	}
	return <span className="text-fg-soft">{String(value)}</span>;
}

function NodeName({ name, indexed }: { name: string; indexed: boolean }) {
	if (indexed) {
		return (
			<span title="array index" className="text-fg-dim">
				{name}
				<span aria-hidden="true">.</span>
			</span>
		);
	}
	return (
		<span title="object key" className="font-medium text-fg-soft">
			{name}
			<span className="text-fg-dim" aria-hidden="true">
				:
			</span>
		</span>
	);
}

/**
 * One node of the tree. Each container owns its own collapse state, so
 * expanding a nested object never re-collapses its siblings or its parent.
 */
function JsonNode({
	name,
	indexed,
	value,
	depth,
	expandDepth,
}: {
	name?: string;
	indexed: boolean;
	value: unknown;
	depth: number;
	expandDepth: number;
}) {
	const [expanded, setExpanded] = useState(depth < expandDepth);

	if (!isContainer(value)) {
		return (
			<div className="flex flex-wrap items-baseline gap-1.5">
				{name !== undefined && <NodeName name={name} indexed={indexed} />}
				<Leaf value={value} />
			</div>
		);
	}

	const entries = entriesOf(value);
	const isArray = Array.isArray(value);

	// An empty container has nothing to expand, so it renders bare and gets no
	// toggle — a disabled chevron would only promise content that is not there.
	if (entries.length === 0) {
		return (
			<div className="flex flex-wrap items-baseline gap-1.5">
				{name !== undefined && <NodeName name={name} indexed={indexed} />}
				<span title={isArray ? 'empty array' : 'empty object'} className="text-fg-dim">
					{isArray ? '[]' : '{}'}
				</span>
			</div>
		);
	}

	const summary = containerSummary(value);
	const Chevron = expanded ? ChevronDown : ChevronRight;
	const label = name ?? (isArray ? 'array' : 'object');

	return (
		<div>
			<button
				type="button"
				onClick={() => setExpanded((open) => !open)}
				aria-expanded={expanded}
				aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label} — ${summary}`}
				className="flex items-baseline gap-1.5 rounded px-0.5 text-left transition-colors hover:bg-hover"
			>
				<Chevron size={12} strokeWidth={2} className="translate-y-px text-fg-dim" aria-hidden="true" />
				{name !== undefined && <NodeName name={name} indexed={indexed} />}
				<span className="text-fg-dim">{expanded ? (isArray ? '[' : '{') : summary}</span>
			</button>
			{expanded && (
				<>
					<div className="ml-[13px] border-l border-line-soft pl-3">
						{entries.map(([childName, childValue]) => (
							<JsonNode
								key={childName}
								name={childName}
								indexed={isArray}
								value={childValue}
								depth={depth + 1}
								expandDepth={expandDepth}
							/>
						))}
					</div>
					<span className="ml-[13px] text-fg-dim">{isArray ? ']' : '}'}</span>
				</>
			)}
		</div>
	);
}

export interface JsonViewProps {
	value: unknown;
	/** Names the root node in the tree and in its toggle's accessible label. */
	rootName?: string;
	/** Nodes shallower than this start expanded. Defaults to 2. */
	expandDepth?: number;
}

/**
 * Recursive JSON viewer. Record values are arbitrary nested JSON and a raw
 * `JSON.stringify` dump is unreadable past the first nesting level, so every
 * container is independently collapsible and every leaf is typed.
 */
export function JsonView({ value, rootName, expandDepth = DEFAULT_EXPAND_DEPTH }: JsonViewProps) {
	return (
		<div className="font-mono text-xs leading-relaxed">
			<JsonNode name={rootName} indexed={false} value={value} depth={0} expandDepth={expandDepth} />
		</div>
	);
}