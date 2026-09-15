// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Compute } from './compute.js';

const REGISTRY_KEY = Symbol.for('BLOCKS_COMPUTE_REGISTRY');

/**
 * Get or create the compute list for a given stack. The list is stored on the
 * stack object (keyed by a Symbol), so each stack in a multi-stack synth gets
 * its own — a compute never leaks into another stack's list. Mirrors the config
 * registry (`config-registry.ts`), which scopes its state the same way.
 */
function getRegistry(stack: cdk.Stack): Compute[] {
	let list = (stack as any)[REGISTRY_KEY] as Compute[] | undefined;
	if (!list) {
		list = [];
		(stack as any)[REGISTRY_KEY] = list;
	}
	return list;
}

/**
 * Register a compute on its owning stack. Called from the {@link Compute} base
 * constructor, so every compute self-registers the moment it is constructed —
 * the finalize steps then enumerate them without a separate discovery pass
 * (mirrors how `registerConfig` accumulates config during the backend import).
 *
 * @param compute - The compute to register (used to locate its stack).
 */
export function registerCompute(compute: Compute): void {
	getRegistry(cdk.Stack.of(compute)).push(compute);
}

/**
 * The computes registered on the stack that owns `scope`, in construction
 * order. Returns an empty array before any compute is constructed.
 *
 * @param scope - Any construct in the stack (used to locate the stack).
 */
export function getComputes(scope: Construct): readonly Compute[] {
	return getRegistry(cdk.Stack.of(scope));
}

/**
 * Map each API namespace in the app to the endpoint of the compute that hosts
 * it — the routing table a front door needs to path-route
 * `/aws-blocks/api/{namespace}` to the right compute.
 *
 * Derived (not stored) from the two facts the framework already tracks: each
 * `ApiNamespace` records itself on its compute (`compute.namespaces`), and each
 * compute exposes its ingress (`compute.endpoint`). Deriving keeps a single
 * source of truth — there is no second representation to drift.
 *
 * Computes without an `endpoint` are skipped: a worker-only compute (queues,
 * cron) has no HTTP ingress, and container computes front through a stack-level
 * shared load balancer rather than per-compute. Their namespaces simply do not
 * appear, and the caller falls back to the default route for them.
 *
 * Call after `create()` has resolved — namespaces are recorded during the
 * backend import, so the map is empty before that.
 *
 * @param scope - Any construct in the stack (used to locate the stack).
 * @throws If one namespace name is claimed by two different computes, which
 *   would make routing ambiguous (and already breaks the runtime's flat
 *   `backend[namespace]` dispatch).
 */
export function getApiEndpoints(scope: Construct): Readonly<Record<string, string>> {
	const endpoints: Record<string, string> = {};
	const owner: Record<string, string> = {};

	for (const compute of getComputes(scope)) {
		const endpoint = compute.endpoint;
		if (!endpoint) continue;
		for (const namespace of compute.namespaces) {
			const previous = owner[namespace];
			// The same compute recording a namespace twice is harmless (same
			// endpoint); two different computes claiming it is a real conflict.
			if (previous !== undefined && previous !== compute.fullId) {
				throw new Error(
					`API namespace "${namespace}" is claimed by two computes ("${previous}" and ` +
						`"${compute.fullId}"). A namespace must be hosted by exactly one compute so ` +
						`requests can be routed to it unambiguously.`,
				);
			}
			owner[namespace] = compute.fullId;
			endpoints[namespace] = endpoint;
		}
	}

	return endpoints;
}
