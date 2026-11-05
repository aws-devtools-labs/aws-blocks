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
 * - `lambdaWebAdapter` — `false` when the stack's region has no Lambda Web
 *   Adapter layer (see `LAMBDA_WEB_ADAPTER_SUPPORTED_REGIONS`), or isn't known
 *   at synth (a stack with no `env`). Nitro then builds `aws-lambda` behind
 *   the HTTP API instead of `node-server`.
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
 * - `reuseBuild` — don't run the framework build; use the output a previous
 *   build left. `'required'`: the caller asked for it explicitly, so a missing
 *   output is the adapter's usual error. `'if-present'`: the synth won't deploy
 *   the frontend (a destroy), so reuse an existing output and build only when
 *   there is none. See {@link shouldSkipBuild}.
 *
 * The caller that knows these choices (core `Hosting`: the front door and the
 * preview mode) wraps the adapter run in {@link withBuildProfile}; adapters
 * read it with {@link buildProfile}. An env var (rather than a new adapter
 * argument) keeps the `FrameworkAdapterFn` signature — and every custom
 * adapter — unchanged.
 */
export type BuildProfile = {
  serverInvoke?: 'default' | 'http-api';
  lambdaWebAdapter?: boolean;
  edgeToRegional?: boolean;
  skipIsr?: boolean;
  skipImageOptimization?: boolean;
  deterministicBuildId?: string;
  reuseBuild?: 'if-present' | 'required';
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
  const { serverInvoke, lambdaWebAdapter, edgeToRegional, skipIsr, skipImageOptimization, deterministicBuildId, reuseBuild } =
    value;
  return {
    ...(serverInvoke === 'default' || serverInvoke === 'http-api' ? { serverInvoke } : {}),
    ...(typeof lambdaWebAdapter === 'boolean' ? { lambdaWebAdapter } : {}),
    ...(typeof edgeToRegional === 'boolean' ? { edgeToRegional } : {}),
    ...(typeof skipIsr === 'boolean' ? { skipIsr } : {}),
    ...(typeof skipImageOptimization === 'boolean' ? { skipImageOptimization } : {}),
    ...(typeof deterministicBuildId === 'string' ? { deterministicBuildId } : {}),
    ...(reuseBuild === 'if-present' || reuseBuild === 'required' ? { reuseBuild } : {}),
  };
};

/**
 * Whether an adapter skips its own framework build. An explicit `skipBuild`
 * option wins; otherwise the profile's `reuseBuild` decides: `'required'`
 * always skips, `'if-present'` skips only when `builtOutputExists()` (the
 * adapter's marker for a finished build) is true.
 */
export const shouldSkipBuild = (explicit: boolean | undefined, builtOutputExists: () => boolean): boolean => {
  if (explicit !== undefined) return explicit;
  const { reuseBuild } = buildProfile();
  if (reuseBuild === 'required') return true;
  if (reuseBuild === 'if-present') return builtOutputExists();
  return false;
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
