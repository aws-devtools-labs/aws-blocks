// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The bundled probe packs, one per Building Block area. A stack mounts them by
 * handing over the instances it already has and a scope to build the rest:
 *
 *   const runners = createProbeRunners(scope, { dsql, realtime });
 *   export const probe = new ApiNamespace(scope, 'probe', () => createProbeMethods(PARITY_CASES, runners));
 *
 * A pack whose dependency a stack does not provide is skipped, and its cases are
 * left out of `listCases()`, so a smaller stack mounts the same packs with fewer deps.
 */

import type { Scope } from '@aws-blocks/blocks';
import type { DistributedDatabase } from '@aws-blocks/bb-distributed-data';
import { parityProbesEnabled } from '../server/namespace.js';
import type { ProbeRunners } from '../server/namespace.js';
import { cfgProbe } from './cfg.probe.js';
import { dsqlProbe } from './dsql.probe.js';
import { fbProbe } from './fb.probe.js';
import { jobProbe } from './job.probe.js';
import { kvProbe } from './kv.probe.js';
import { msgProbe } from './msg.probe.js';
import type { ProbeRealtime } from './msg.probe.js';

export { PARITY_CASES } from './catalog.js';
export type { ProbeRealtime } from './msg.probe.js';

/** Existing stack instances packs reuse. Leave one out and the packs that need it are skipped. */
export interface ProbeDeps {
	/** A DistributedDatabase whose migrations create `dsql_items (id TEXT PRIMARY KEY, name TEXT, value INTEGER)`. */
	readonly dsql?: DistributedDatabase;
	/** The stack's Realtime instance (packs reuse it: Realtime shares per-stack WebSocket infrastructure). */
	readonly realtime?: ProbeRealtime;
}

/** Packs that build their own instances from `scope` and need nothing from the stack. */
export const SELF_CONTAINED_PACKS = ['kv', 'fb', 'cfg', 'job'] as const;

/**
 * Build every pack's runner. Call ONCE at module top level of the stack's backend:
 * packs construct their own Building Block instances here, and a constructor is
 * the side effect that provisions infrastructure at synth.
 *
 * Without `E2E_PARITY_PROBES=true` no pack is built, so an ordinary deploy gets
 * none of the packs' resources (queues, tables, buckets, a once-a-minute cron).
 * The flag is visible at module load in every layer: the synth process inherits
 * it, the dev server is spawned with it, and the Lambda runtime loads registered
 * config into `process.env` before it imports the backend.
 */
export function createProbeRunners(scope: Scope, deps: ProbeDeps = {}): ProbeRunners {
	if (!parityProbesEnabled()) return {};
	return {
		...(deps.dsql ? { dsql: dsqlProbe(deps.dsql) } : {}),
		kv: kvProbe(scope),
		fb: fbProbe(scope),
		cfg: cfgProbe(scope),
		job: jobProbe(scope),
		...(deps.realtime ? { msg: msgProbe(scope, { realtime: deps.realtime }) } : {}),
	};
}
