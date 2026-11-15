/**
 * A `cdk` export condition in a `NODE_OPTIONS` value, in each spelling Node.js
 * accepts there (`--conditions=cdk`, `--conditions cdk`, `-C cdk`), with the
 * whitespace before it.
 */
const CDK_CONDITION = /(^|\s+)(?:--conditions(?:=|\s+)|-C\s+)cdk(?=\s|$)/g;

/**
 * The environment for the app's own build command (`npm run build`, a custom
 * `buildCommand`), spawned by a framework adapter.
 *
 * Adapters run during CDK synth, and a synth runs with
 * `NODE_OPTIONS=--conditions=cdk` so that `@aws-blocks/*` packages resolve to
 * their CDK constructs. A child process inherits `NODE_OPTIONS`, so without
 * this every Node.js process in the app's build (a `prebuild` script, the
 * bundler, a prerender) would resolve those packages through the `cdk`
 * condition too, and construct infrastructure outside a stack instead of
 * running the app's code.
 *
 * Only the `cdk` condition is removed: any other `NODE_OPTIONS` entry (a heap
 * size, another condition, a `--require`) reaches the build unchanged.
 *
 * @param overrides variables to set on top of the current environment.
 * @returns a copy of `process.env` with `overrides` applied and the `cdk`
 * condition removed from `NODE_OPTIONS`.
 */
export const appBuildEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  if (env.NODE_OPTIONS !== undefined) {
    env.NODE_OPTIONS = env.NODE_OPTIONS.replace(CDK_CONDITION, '').trim();
  }
  return env;
};
