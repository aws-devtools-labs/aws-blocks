// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A `cdk` export condition in a `NODE_OPTIONS` value, with the whitespace
 * after it. Matches `--conditions=cdk`, `--conditions cdk` and `-C cdk`, and
 * the same with double quotes around the value (`--conditions="cdk"`,
 * `-C "cdk"`) or around the whole entry (`"--conditions=cdk"`), because
 * Node.js removes those quotes when it parses `NODE_OPTIONS`. Another
 * condition that starts with `cdk` (`--conditions=cdk-preview`) does not match.
 *
 * The entry start is a lookbehind rather than a leading `\s+`, so matching
 * stays linear in the length of the value (no backtracking over runs of
 * whitespace).
 */
const CDK_CONDITION = /(?<!\S)("?)(?:--conditions(?:=|\s+)|-C\s+)("?)cdk\2\1(?!\S)\s*/g;

/**
 * The environment for the app's own build command (`npm run build`, a custom
 * `buildCommand`), spawned by a framework adapter or by the `@aws-cdk-blocks/core`
 * `Hosting` construct.
 *
 * Both run during CDK synth, and a synth runs with
 * `NODE_OPTIONS=--conditions=cdk` so that `@aws-cdk-blocks/*` packages resolve to
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
