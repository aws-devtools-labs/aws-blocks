// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';

const REGISTRY_KEY = Symbol.for('BLOCKS_DASHBOARD_REGISTRY');

/** A Dashboard's deferred widget-body build, run once after the app is constructed. */
type DashboardFinalizer = () => void;

/**
 * Get or create the deferred-dashboard list for a given stack. Stored on the
 * stack object (keyed by a Symbol), so each stack in a multi-stack synth gets
 * its own — mirrors the config + compute registries.
 */
function getRegistry(stack: cdk.Stack): DashboardFinalizer[] {
	let list = (stack as unknown as Record<symbol, DashboardFinalizer[] | undefined>)[REGISTRY_KEY];
	if (!list) {
		list = [];
		(stack as unknown as Record<symbol, DashboardFinalizer[]>)[REGISTRY_KEY] = list;
	}
	return list;
}

/**
 * Register a Dashboard's deferred body-build, to run after every Building Block
 * in the app has been constructed (the end of `BlocksStack`/`BlocksBackend`
 * `create()`, once the backend module has fully imported).
 *
 * The Dashboard builds its widgets here rather than in its constructor because
 * the body depends on which computes have a Logger/Tracer attached, and those
 * are marked by Logger/Tracer constructors — which may run *after* the Dashboard
 * is constructed. Deferring makes the Dashboard observe the complete app, so it
 * never depends on the order the customer constructed things in.
 *
 * This is intentionally scoped to the Dashboard (the only deferred-build case
 * today) rather than a generic finalizer mechanism; generalize it only if a
 * second use case appears.
 *
 * @param scope - Any construct in the stack (used to locate the stack).
 * @param finalize - The deferred body-build; run once (in registration order)
 *   by {@link finalizeDashboards}.
 */
export function registerDashboardFinalizer(scope: Construct, finalize: DashboardFinalizer): void {
	getRegistry(cdk.Stack.of(scope)).push(finalize);
}

/**
 * Run — and clear — every registered Dashboard finalizer on `scope`'s stack, in
 * registration order. Called once from `create()` after the backend module has
 * imported. Clearing the list makes a repeated call a no-op, so a dashboard's
 * body is never built twice.
 *
 * A Dashboard constructed outside `create()` (e.g. directly in a unit test) must
 * call this explicitly before synth — the same way `config-registry.test.ts`
 * drives `finalizeConfigRegistry`.
 *
 * @param scope - Any construct in the stack (used to locate the stack).
 */
export function finalizeDashboards(scope: Construct): void {
	const list = getRegistry(cdk.Stack.of(scope));
	// Drain the list so a repeated call can't rebuild an already-built dashboard.
	const pending = list.splice(0, list.length);
	for (const finalize of pending) finalize();
}
