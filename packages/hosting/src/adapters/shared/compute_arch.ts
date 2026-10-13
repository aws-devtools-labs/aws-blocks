/**
 * Target CPU architecture of the compute an adapter's server bundle runs on.
 *
 * Most bundles are pure JavaScript, but some adapters install native modules
 * into the server bundle (Astro's `sharp` for `/_image`). Those must match the
 * deploy target: `x64` for Lambda (the default) and `arm64` for Lambda Web
 * Functions. The caller that knows the compute choice (core `Hosting`) wraps
 * the adapter run in {@link withComputeArch}; adapters read it with
 * {@link targetComputeArch}. An env var (rather than a new adapter argument)
 * keeps the `FrameworkAdapterFn` signature — and every custom adapter —
 * unchanged.
 */
export type ComputeArch = 'x64' | 'arm64';

/** @internal */
export const COMPUTE_ARCH_ENV = 'BLOCKS_HOSTING_COMPUTE_ARCH';

/** The architecture the current adapter run targets. Default: `x64`. */
export const targetComputeArch = (): ComputeArch =>
  process.env[COMPUTE_ARCH_ENV] === 'arm64' ? 'arm64' : 'x64';

/** Run `fn` (an adapter invocation) targeting `arch`, restoring the previous value after. */
export const withComputeArch = <T>(arch: ComputeArch, fn: () => T): T => {
  const previous = process.env[COMPUTE_ARCH_ENV];
  process.env[COMPUTE_ARCH_ENV] = arch;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[COMPUTE_ARCH_ENV];
    else process.env[COMPUTE_ARCH_ENV] = previous;
  }
};
