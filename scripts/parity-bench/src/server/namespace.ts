// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `probe` RPC namespace a stack mounts:
 *
 *   export const probe = new ApiNamespace(scope, 'probe', () => createProbeMethods(PARITY_CASES, runners));
 *
 * TEST-ONLY, DEFAULT-DENY. Every method answers 404 unless `E2E_PARITY_PROBES` is
 * exactly `'true'` in the serving process and that process is not a production
 * deployment (see `parityProbesEnabled`). The methods carry no auth of their own:
 * while the flag is on, anyone who can reach the stack can run catalog cases, so
 * enable it only on a throwaway sandbox stack in a test account. Callers pick
 * a case id from the fixed catalog; a slider case additionally takes one integer,
 * which must lie inside the range the catalog declares for that case. Nothing else
 * — SQL, sizes, targets — comes from the caller.
 */

import { ApiError, getDeploymentType } from '@aws-blocks/core';
import type { ParityCase, ProbeResult, ProbeRunner } from '../core/types.js';

export type ProbeRunners = Readonly<Record<string, ProbeRunner>>;

/**
 * The opt-in flag. Read it at call time or module load; every layer sees it (see `enableParityProbes`).
 * Always false on a production deployment, including deployed compute whose config has not loaded
 * (which `getDeploymentType()` reports as production), so the probes fail closed.
 */
export function parityProbesEnabled(): boolean {
	return process.env.E2E_PARITY_PROBES === 'true' && getDeploymentType() !== 'production';
}

function notFound(): ApiError {
	return new ApiError('Not found', 404);
}

export function createProbeMethods(catalog: readonly ParityCase[], runners: ProbeRunners) {
	const resolve = (caseId: string): { c: ParityCase; runner: ProbeRunner } => {
		if (!parityProbesEnabled()) throw notFound();
		const c = catalog.find((x) => x.id === caseId);
		const runner = c && runners[c.pack];
		if (!c || !runner) throw notFound();
		return { c, runner };
	};
	return {
		/** The catalog this backend can execute. */
		async listCases(): Promise<readonly ParityCase[]> {
			if (!parityProbesEnabled()) throw notFound();
			return catalog.filter((c) => runners[c.pack]);
		},

		/** Execute one fixed catalog case and report what the Building Block did. */
		async run(caseId: string): Promise<ProbeResult> {
			const { c, runner } = resolve(caseId);
			if (c.sweep) throw new ApiError('Slider case: use attempt(caseId, value)', 400);
			return { caseId, ...(await runner(c)) };
		},

		/** Execute one slider case at `value`, which must lie inside the case's declared sweep range. */
		async attempt(caseId: string, value: number): Promise<ProbeResult> {
			const { c, runner } = resolve(caseId);
			const sweep = c.sweep;
			if (!sweep) throw new ApiError('Not a slider case: use run(caseId)', 400);
			if (!Number.isInteger(value) || value < sweep.min || value > sweep.max) {
				throw new ApiError(`value must be an integer in [${sweep.min}, ${sweep.max}]`, 400);
			}
			return { caseId, ...(await runner({ ...c, params: { ...c.params, [sweep.param]: value } })) };
		},
	};
}
