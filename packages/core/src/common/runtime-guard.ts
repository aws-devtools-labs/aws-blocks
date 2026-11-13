// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime guard for Building Block mock entry points.
 *
 * Building Blocks swap implementations through npm conditional exports that a
 * bundler resolves at BUILD time:
 *
 * - `cdk` → the CDK construct (synth). Guarded at runtime by
 *   `assertCdkConditionActive()` in `cdk/blocks-backend.ts`.
 * - `aws-runtime` → the real AWS-backed implementation (deployed compute).
 * - `default` → the local-dev mock (in-memory / on-disk stubs).
 *
 * If a backend is bundled without the `aws-runtime` condition, resolution
 * falls back to `default` and the deployed artifact contains the mocks. This
 * module is the runtime twin of `assertCdkConditionActive()` for that case:
 * every BB mock entry calls {@link assertNotMockInDeployedEnv} at module load,
 * so a mis-bundled artifact fails when the backend loads (at process start on
 * container/AgentCore, on the first invocation on Lambda) instead of running mocks.
 *
 * @module
 */

import { getCachedConfigValue } from './config.js';

/**
 * Whether this process is running on deployed compute.
 *
 * The signal is compute-agnostic: `BLOCKS_CONFIG_BUCKET` and
 * `BLOCKS_CONFIG_KEY` are stamped on every registered compute at synth by
 * `finalizeConfigRegistry()` (`cdk/config-registry.ts`) via `compute.setEnv()`,
 * and set explicitly by the AgentCore runtime construct. They are absent in
 * local dev and tests. This is the same contract `loadConfigFromS3()` in
 * `common/config.ts` uses to decide local-vs-deployed, so the two never
 * disagree.
 *
 * It deliberately does NOT use `AWS_LAMBDA_*` / `AWS_EXECUTION_ENV`: those are
 * Lambda-only, so the guard would be a no-op on ECS/Fargate, AgentCore, or
 * customer-owned compute.
 *
 * Both variables must be non-empty; a partial configuration is not treated as
 * a deployed signal.
 *
 * Consequence to keep in mind: on deployed compute that Blocks does not
 * configure (a customer-owned bundler, container image, or other platform that
 * sets neither variable) this returns false and the guard is intentionally
 * inert — it is a deliberate no-op, not a bug. There the `aws-runtime` bundler
 * condition is the sole protection; see the "compute target Blocks doesn't own"
 * guidance in `docs/guides/extending-with-existing-aws-resources.md`.
 */
function isDeployedEnv(): boolean {
	return Boolean(process.env.BLOCKS_CONFIG_BUCKET) && Boolean(process.env.BLOCKS_CONFIG_KEY);
}

/** Where the current process is running. See {@link getDeploymentType}. */
export type DeploymentType = 'local' | 'sandbox' | 'production';

/**
 * The deployment type of the current process.
 *
 * - `'local'` — local dev or tests (no Blocks deployed configuration).
 * - `'sandbox'` — deployed by the sandbox dev loop (`sandboxMode` CDK context).
 * - `'production'` — any other deployment.
 *
 * The value is decided at synth: `BlocksStack.create` / `BlocksBackend.create`
 * derive it from `isSandboxContext()` and set `BLOCKS_DEPLOYMENT_TYPE` both in
 * the synth process and in the BB config delivered to deployed compute.
 *
 * Where it is read from depends on where the process runs:
 *
 * - On deployed compute (see `isDeployedEnv()`), ONLY the loaded BB config is
 *   consulted. `process.env.BLOCKS_DEPLOYMENT_TYPE` is ignored there, so an
 *   environment variable set on the compute cannot change the synth-time value
 *   (`loadConfigToProcessEnv()` keeps a pre-set env var rather than
 *   overwriting it, so `process.env` is not reliable for this key).
 * - Elsewhere (synth, local dev, tests) `process.env.BLOCKS_DEPLOYMENT_TYPE` is
 *   read, which is how the synth process sees the value `BlocksStack.create`
 *   just set.
 *
 * An absent or unrecognized value is treated as unset, and the result falls
 * back to the same local-vs-deployed signal as `assertNotMockInDeployedEnv()`:
 * `'production'` when deployed, else `'local'`. Deployed compute therefore
 * reports `'sandbox'` only when the loaded config says so; that includes the
 * case where the config has not been loaded yet, which reports `'production'`.
 *
 * So the same value is reported at synth and at runtime only inside the backend
 * module (once `BlocksStack.create` / `BlocksBackend.create` has begun importing
 * it) and on deployed compute. Wherever Blocks config and context are not
 * present (before `create()`, plain scripts, compute Blocks does not configure)
 * this returns `'local'`.
 *
 * Note: on deployed compute call this after the config has been loaded
 * (`loadConfigToProcessEnv()` / `preloadConfig()`), as the Blocks Lambda,
 * container, and AgentCore entry points do before importing the backend.
 */
export function getDeploymentType(): DeploymentType {
	const deployed = isDeployedEnv();
	const value = deployed ? getCachedConfigValue('BLOCKS_DEPLOYMENT_TYPE') : process.env.BLOCKS_DEPLOYMENT_TYPE;
	if (value === 'sandbox' || value === 'production') return value;
	return deployed ? 'production' : 'local';
}

/**
 * Fail closed when a Building Block MOCK entry is loaded on deployed compute.
 *
 * Call this at the top level of a BB's mock (`default` export) entry. In local
 * dev and tests it is a no-op, so mocks behave exactly as before. On deployed
 * compute — Lambda, ECS/Fargate, AgentCore, or customer-owned compute, detected
 * via `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY` rather than any
 * Lambda-specific variable — it throws, because reaching the mock there means
 * the artifact was bundled without the `aws-runtime` export condition.
 *
 * This is the runtime counterpart of `assertCdkConditionActive()`, which
 * performs the equivalent check for the `cdk` condition at synth.
 *
 * Load order: BBs are ESM, so a top-level call in a mock entry runs after that
 * entry's own static imports and re-exports have been evaluated. In a
 * mis-bundled deployed artifact the throw still aborts the module graph before
 * any handler runs, but in a BB that imports another BB the deeper BB's guard
 * may fire first, so the error can name a different BB than the one you import.
 *
 * @param bbName - Building Block package name used in the error message (e.g. `'bb-kv-store'`).
 * @throws Error when loaded in a deployed environment.
 */
export function assertNotMockInDeployedEnv(bbName: string): void {
	if (!isDeployedEnv()) return;

	throw new Error(
		`A Building Block mock entry (first detected: ${bbName}) was loaded in a deployed environment.\n\n` +
			'This artifact was bundled without the `aws-runtime` export condition, so module resolution ' +
			'fell back to the `default` (mock) entries. Every Building Block resolved this way runs an ' +
			'in-memory stub instead of the real AWS-backed implementation; the one named above is just the ' +
			'first whose guard ran.\n\n' +
			'Fix: resolve the aws-runtime condition, e.g.\n' +
			'  esbuild --conditions=aws-runtime ...\n' +
			"  or conditions: ['aws-runtime', 'module'] in esbuild build() options\n" +
			'  or, for unbundled Node, node --conditions=aws-runtime ... / NODE_OPTIONS=--conditions=aws-runtime\n\n' +
			'See https://github.com/aws-devtools-labs/aws-blocks/blob/main/docs/guides/extending-with-existing-aws-resources.md',
	);
}
