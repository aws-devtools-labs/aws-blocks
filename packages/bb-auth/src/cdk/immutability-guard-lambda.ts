// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Layer 2 of the immutability guard (decision Q5): the deploy-time
 * custom-resource handler (`onEvent` of a `cr.Provider`).
 *
 * Every user pool the stack's `Auth` blocks own **depends on** this custom
 * resource, so CloudFormation runs it before it updates any pool. It refuses —
 * with an actionable message instead of a stack rollback — a deploy that
 * changes one of the four properties Cognito cannot change on an existing pool
 * (`immutability.ts`). The pool is never touched when it refuses.
 *
 * Per pool, the "before" state is:
 * - on **Update**: the snapshot this resource was last deployed with
 *   (`OldResourceProperties`). CloudFormation computes the pool update from the
 *   same template diff, and the four properties cannot drift on the live pool,
 *   so that is exactly what the pool update would attempt;
 * - otherwise (**Create** — the guard is new next to a pool that may already
 *   exist, e.g. an `AuthCognito` app switching to `Auth` — or a pool new to the
 *   guard): the **live** pool. It is located by its logical id in this stack
 *   (`DescribeStackResource`), never by name — Cognito allows duplicate pool
 *   names, and a retained pool from a deleted stack carries the same name. Not
 *   in the stack yet → it is about to be created → nothing to protect.
 *
 * Never blocks a delete or a rollback: Delete is a no-op that makes no AWS call,
 * and Create/Update pass unconditionally while the stack is rolling back (a
 * rollback re-sends the *previous* snapshot, which is "a change" from the
 * failed one). Lookup failures pass with a log line — the guard exists to turn
 * a certain rollback into a clear message, never to add a new way to fail.
 *
 * Bundled to `dist/immutability-guard-lambda/index.js` (esbuild,
 * `build:lambda`); `@aws-sdk/*` is provided by the Lambda runtime.
 *
 * @internal
 */

import {
	CloudFormationClient,
	DescribeStackResourceCommand,
	DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { CognitoIdentityProviderClient, DescribeUserPoolCommand } from '@aws-sdk/client-cognito-identity-provider';
import {
	diffImmutables,
	type LiveUserPool,
	type PoolImmutables,
	parseSnapshot,
	REMEDY,
	snapshotFromLive,
} from './immutability.js';

/** The custom resource's physical id — constant, so an Update never replaces it. */
export const GUARD_PHYSICAL_ID = 'blocks-auth-pool-guard';

/** One guarded pool, as `immutability-guard.ts` writes it into `ResourceProperties.Pools`. */
export interface GuardedPool {
	FullId: string;
	PoolLogicalId: string;
	/** `JSON.stringify` of the pool's {@link PoolImmutables}. */
	Snapshot: string;
}

/** The subset of a CloudFormation custom-resource event the guard reads. */
export interface GuardEvent {
	RequestType: 'Create' | 'Update' | 'Delete';
	StackId: string;
	PhysicalResourceId?: string;
	ResourceProperties: Record<string, unknown>;
	OldResourceProperties?: Record<string, unknown>;
}

/** Anything with the SDK v3 `send` shape. Tests pass stubs; the Lambda passes real clients. */
export interface SdkClient {
	send(command: object): Promise<unknown>;
}

export interface GuardDeps {
	cloudformation: SdkClient;
	cognito: SdkClient;
	log?: (message: string) => void;
}

function readPools(
	props: Record<string, unknown> | undefined,
): Map<string, { logicalId: string; snapshot?: PoolImmutables }> {
	const out = new Map<string, { logicalId: string; snapshot?: PoolImmutables }>();
	const pools = props?.Pools;
	if (!Array.isArray(pools)) return out;
	for (const entry of pools) {
		if (typeof entry !== 'object' || entry === null) continue;
		const { FullId, PoolLogicalId, Snapshot } = entry as Record<string, unknown>;
		if (typeof FullId !== 'string' || typeof PoolLogicalId !== 'string') continue;
		out.set(FullId, { logicalId: PoolLogicalId, snapshot: parseSnapshot(Snapshot) });
	}
	return out;
}

function errorName(e: unknown): string {
	return typeof e === 'object' && e !== null && 'name' in e ? String(e.name) : '';
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

async function stackIsRollingBack(deps: GuardDeps, stackId: string, log: (m: string) => void): Promise<boolean> {
	try {
		const out = (await deps.cloudformation.send(new DescribeStacksCommand({ StackName: stackId }))) as {
			Stacks?: { StackStatus?: string }[];
		};
		const status = out.Stacks?.[0]?.StackStatus ?? '';
		return status.includes('ROLLBACK');
	} catch (e) {
		// Unknown status: assume a rollback, so the guard can never wedge one.
		log(`pool guard: DescribeStacks failed (${errorName(e) || errorMessage(e)}); passing.`);
		return true;
	}
}

/** The live pool for `logicalId` in this stack, or `undefined` when there is none yet (or it can't be read). */
async function livePool(
	deps: GuardDeps,
	stackId: string,
	logicalId: string,
	log: (m: string) => void,
): Promise<LiveUserPool | undefined> {
	let poolId: string | undefined;
	try {
		const out = (await deps.cloudformation.send(
			new DescribeStackResourceCommand({ StackName: stackId, LogicalResourceId: logicalId }),
		)) as { StackResourceDetail?: { PhysicalResourceId?: string; ResourceStatus?: string } };
		const detail = out.StackResourceDetail;
		const status = detail?.ResourceStatus ?? '';
		if (status === 'CREATE_FAILED' || status.startsWith('DELETE')) return undefined;
		poolId = detail?.PhysicalResourceId || undefined;
	} catch (e) {
		// "Resource <id> does not exist for stack <arn>": the pool is about to be created.
		if (errorName(e) !== 'ValidationError')
			log(`pool guard: DescribeStackResource(${logicalId}) failed: ${errorMessage(e)}; passing.`);
		return undefined;
	}
	if (!poolId) return undefined;
	try {
		const out = (await deps.cognito.send(new DescribeUserPoolCommand({ UserPoolId: poolId }))) as {
			UserPool?: LiveUserPool;
		};
		return out.UserPool;
	} catch (e) {
		if (errorName(e) !== 'ResourceNotFoundException') {
			log(`pool guard: DescribeUserPool(${poolId}) failed: ${errorMessage(e)}; passing.`);
		}
		return undefined;
	}
}

/**
 * Build the `onEvent` handler around injected SDK clients. Returns the
 * physical id on success; throws (the Provider framework reports `FAILED` with
 * the message as the CloudFormation status reason) when a pool change would be
 * rejected by Cognito.
 */
export function createGuardHandler(deps: GuardDeps): (event: GuardEvent) => Promise<{ PhysicalResourceId: string }> {
	const log = deps.log ?? ((m: string) => console.log(m));
	return async (event) => {
		const physicalId = event.PhysicalResourceId || GUARD_PHYSICAL_ID;
		// Delete: nothing to check, no AWS call — never block stack deletion or a rollback.
		if (event.RequestType === 'Delete') return { PhysicalResourceId: physicalId };
		if (await stackIsRollingBack(deps, event.StackId, log)) {
			log('pool guard: stack is rolling back; passing.');
			return { PhysicalResourceId: physicalId };
		}

		const current = readPools(event.ResourceProperties);
		const previous = event.RequestType === 'Update' ? readPools(event.OldResourceProperties) : new Map();
		const failures: string[] = [];
		for (const [fullId, pool] of current) {
			// Not a snapshot this version understands — nothing reliable to compare against.
			if (!pool.snapshot) continue;
			const old = previous.get(fullId);
			let before = old?.logicalId === pool.logicalId ? old.snapshot : undefined;
			let beforeIsLive = false;
			if (!before) {
				const live = await livePool(deps, event.StackId, pool.logicalId, log);
				if (!live) continue;
				before = snapshotFromLive(live);
				beforeIsLive = true;
			}
			const violations = diffImmutables(before, pool.snapshot, { beforeIsLive });
			if (violations.length === 0) continue;
			failures.push(
				[
					`Auth '${fullId}': refused before the user-pool update ran (the pool was not modified).`,
					...violations.map((v) => `- ${v.change}. ${v.why}`),
					`Remedy: ${REMEDY}`,
				].join(' '),
			);
		}
		// Pools that left `Pools` are being removed from the stack. Not this layer's
		// call: with one pool the guard itself goes with it, so it could not refuse
		// consistently. The synth-time baseline (layer 1) refuses pool removal.
		if (failures.length > 0) throw new Error(failures.join(' | '));
		return { PhysicalResourceId: physicalId };
	};
}

/** The Lambda entry point. */
export const handler = createGuardHandler({
	cloudformation: new CloudFormationClient({}),
	cognito: new CognitoIdentityProviderClient({}),
});
