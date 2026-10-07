// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The binding rule: a `Database` is bound to one cluster, by id and type, at its
 * first deploy, and any deploy that would change either stops. This module holds
 * the record format, the per-block dev-server marker, the pure diff, and the one
 * stop-message text the dev server and the deploy guard both print.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BINDING_MARKER_FILE, DEFAULT_CLUSTER_ID, EXTERNAL_CLUSTER_ID } from './constants.js';
import { configError } from './errors.js';
import type { Bindings, ClusterKind, DatabaseBinding } from './types.js';

/** A binding change the guard refuses. */
export interface BindingChange {
	fullId: string;
	from: DatabaseBinding;
	to: DatabaseBinding;
}

/** Describe a cluster for the stop message: `its default cluster (distributed)` or `'app-main' (provisioned)`. */
export function describeCluster(binding: DatabaseBinding): string {
	if (binding.cluster === DEFAULT_CLUSTER_ID) return `its default cluster (${binding.type})`;
	if (binding.cluster === EXTERNAL_CLUSTER_ID) return 'an external cluster';
	return `'${binding.cluster}' (${binding.type})`;
}

/** The target half of the stop message. */
function describeTarget(binding: DatabaseBinding): string {
	if (binding.cluster === DEFAULT_CLUSTER_ID) return `its default cluster (${binding.type})`;
	if (binding.cluster === EXTERNAL_CLUSTER_ID) return 'an external cluster';
	return `'${binding.cluster}' (${binding.type})`;
}

/**
 * The guard's stop message. One text, printed by the dev server and the deploy
 * guard alike. `removalPolicy` names what happens to the data left behind.
 */
export function formatBindingStop(
	change: BindingChange,
	options: { removalPolicy?: string; shortId?: string } = {},
): string {
	const shortId = options.shortId ?? change.fullId.split('-').pop() ?? change.fullId;
	const target = change.to.cluster === DEFAULT_CLUSTER_ID ? 'its default cluster' : `'${change.to.cluster}'`;
	const policy = options.removalPolicy ?? 'retain';
	return (
		`Deploy stopped: Database '${change.fullId}' is bound to ${describeCluster(change.from)} and cannot move to ${describeTarget(change.to)}.\n` +
		`A Database keeps its cluster for life. To change clusters: add a new Database on ${target}, copy the data, switch your handlers, then remove '${shortId}'.\n` +
		`Data on ${change.from.cluster === DEFAULT_CLUSTER_ID ? 'the default cluster' : `'${change.from.cluster}'`} is retained (removal policy: ${policy}).`
	);
}

/**
 * Diff two binding records. Returns every `databases` entry whose cluster id or
 * type differs between `deployed` and `next`. New blocks and deleted blocks are
 * not changes: deleting a block retains its data under the removal policy.
 */
export function diffBindings(deployed: Bindings | undefined, next: Bindings): BindingChange[] {
	if (!deployed) return [];
	const changes: BindingChange[] = [];
	for (const [fullId, to] of Object.entries(next.databases ?? {})) {
		const from = deployed.databases?.[fullId];
		if (!from) continue;
		if (from.cluster !== to.cluster || from.type !== to.type) changes.push({ fullId, from, to });
	}
	return changes;
}

/** An empty record. */
export function emptyBindings(): Bindings {
	return { databases: {}, clusters: {} };
}

/** Read a block's dev-server marker, or `undefined` when none has been written. */
export function readBindingMarker(dataDir: string): DatabaseBinding | undefined {
	const file = join(dataDir, BINDING_MARKER_FILE);
	if (!existsSync(file)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<DatabaseBinding>;
		if (typeof parsed.cluster === 'string' && typeof parsed.type === 'string') {
			return { cluster: parsed.cluster, type: parsed.type as ClusterKind };
		}
	} catch {
		/* unreadable marker → treat as absent; it is rewritten below */
	}
	return undefined;
}

/** Write a block's dev-server marker. */
export function writeBindingMarker(dataDir: string, binding: DatabaseBinding): void {
	const file = join(dataDir, BINDING_MARKER_FILE);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(binding, null, 2)}\n`);
}

/**
 * The dev server's half of the binding rule: compare the marker in
 * `.bb-data/{fullId}/` with the code and stop when they disagree. Writes the
 * marker on first sight. Deleting `.bb-data` is the reset.
 */
export function enforceLocalBinding(dataDir: string, fullId: string, shortId: string, binding: DatabaseBinding): void {
	const existing = readBindingMarker(dataDir);
	if (existing && (existing.cluster !== binding.cluster || existing.type !== binding.type)) {
		const message = formatBindingStop(
			{ fullId, from: existing, to: binding },
			{ shortId, removalPolicy: 'local .bb-data' },
		);
		throw configError(`${message}\nLocal mode: delete .bb-data/${fullId} to reset the binding instead.`);
	}
	if (!existing) writeBindingMarker(dataDir, binding);
}
