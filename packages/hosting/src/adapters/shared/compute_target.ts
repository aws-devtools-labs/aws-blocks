/**
 * The compute an adapter's server bundle is being built for.
 *
 * - `'lambda'` (default) — a Lambda function behind API Gateway: OpenNext
 *   builds an API Gateway event handler, Nitro the `aws-lambda` preset, native
 *   modules target x64.
 * - `'web-function'` — AWS Lambda Web Functions (`compute.type:
 *   'web-function'`): the bundle must start a plain Node.js HTTP server
 *   (OpenNext `node` wrapper, Nitro `node-server`), and native modules (Astro's
 *   `sharp`) must target Arm64.
 *
 * The caller that knows the compute choice (core `Hosting`) wraps the adapter
 * run in {@link withComputeTarget}; adapters read it with
 * {@link targetCompute} / {@link targetComputeArch}. An env var (rather than a
 * new adapter argument) keeps the `FrameworkAdapterFn` signature — and every
 * custom adapter — unchanged.
 */
export type ComputeTarget = 'lambda' | 'web-function';

/** CPU architecture of a {@link ComputeTarget}. */
export type ComputeArch = 'x64' | 'arm64';

/** @internal */
export const COMPUTE_TARGET_ENV = 'BLOCKS_HOSTING_COMPUTE_TARGET';

/** The compute the current adapter run targets. Default: `'lambda'`. */
export const targetCompute = (): ComputeTarget =>
  process.env[COMPUTE_TARGET_ENV] === 'web-function' ? 'web-function' : 'lambda';

/** The CPU architecture the current adapter run targets: `arm64` for Web Functions, else `x64`. */
export const targetComputeArch = (): ComputeArch => (targetCompute() === 'web-function' ? 'arm64' : 'x64');

/** Run `fn` (an adapter invocation) targeting `target`, restoring the previous value after. */
export const withComputeTarget = <T>(target: ComputeTarget, fn: () => T): T => {
  const previous = process.env[COMPUTE_TARGET_ENV];
  process.env[COMPUTE_TARGET_ENV] = target;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[COMPUTE_TARGET_ENV];
    else process.env[COMPUTE_TARGET_ENV] = previous;
  }
};
