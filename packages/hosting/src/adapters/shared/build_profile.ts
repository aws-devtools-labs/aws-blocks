/**
 * How an adapter's build is shaped for the deploy around it, beyond the
 * compute target (see `compute_target.ts`).
 *
 * - `serverInvoke` — how the front door invokes the server function.
 *   `'http-api'` means an API Gateway HTTP API Lambda integration: payload
 *   format 2.0, buffered (an HTTP API can't stream). OpenNext then builds the
 *   server with the `aws-apigw-v2` converter and the buffered `aws-lambda`
 *   wrapper, and Nitro builds `node-server` (a Lambda Web Adapter server, run
 *   buffered) unless the app picked a preset. `'default'` keeps the API Gateway
 *   REST (payload 1.0, streamed) build.
 * - `edgeToRegional` — build Next.js `runtime: 'edge'` routes as regional
 *   Lambda functions instead of Lambda@Edge.
 * - `skipIsr` — build without the incremental-regeneration machinery: no tag
 *   cache and no revalidation queue. Prerendered pages are still served from
 *   the build's cache snapshot.
 * - `skipImageOptimization` — build no image-optimization function, and
 *   install no `sharp` for one.
 * - `deterministicBuildId` — pin the framework's build id (Next.js
 *   `generateBuildId`), so an unchanged build produces byte-identical static
 *   assets and a re-deploy skips the asset re-upload.
 *
 * The caller that knows these choices (core `Hosting`: the front door and the
 * preview mode) wraps the adapter run in {@link withBuildProfile}; adapters
 * read it with {@link buildProfile}. An env var (rather than a new adapter
 * argument) keeps the `FrameworkAdapterFn` signature — and every custom
 * adapter — unchanged.
 */
export type BuildProfile = {
  serverInvoke?: 'default' | 'http-api';
  edgeToRegional?: boolean;
  skipIsr?: boolean;
  skipImageOptimization?: boolean;
  deterministicBuildId?: string;
};

/** @internal */
export const BUILD_PROFILE_ENV = 'BLOCKS_HOSTING_BUILD_PROFILE';

/**
 * The profile the current adapter run builds for. Default: `{}` (the production
 * build). Only the known fields with the right type are read, so a malformed
 * env value can't hand an adapter an unexpected shape.
 */
export const buildProfile = (): BuildProfile => {
  const raw = process.env[BUILD_PROFILE_ENV];
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const value: Record<string, unknown> = { ...parsed };
  const { serverInvoke, edgeToRegional, skipIsr, skipImageOptimization, deterministicBuildId } = value;
  return {
    ...(serverInvoke === 'default' || serverInvoke === 'http-api' ? { serverInvoke } : {}),
    ...(typeof edgeToRegional === 'boolean' ? { edgeToRegional } : {}),
    ...(typeof skipIsr === 'boolean' ? { skipIsr } : {}),
    ...(typeof skipImageOptimization === 'boolean' ? { skipImageOptimization } : {}),
    ...(typeof deterministicBuildId === 'string' ? { deterministicBuildId } : {}),
  };
};

/** Run `fn` (an adapter invocation) with `profile`, restoring the previous value after. */
export const withBuildProfile = <T>(profile: BuildProfile, fn: () => T): T => {
  const previous = process.env[BUILD_PROFILE_ENV];
  process.env[BUILD_PROFILE_ENV] = JSON.stringify(profile);
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[BUILD_PROFILE_ENV];
    else process.env[BUILD_PROFILE_ENV] = previous;
  }
};
