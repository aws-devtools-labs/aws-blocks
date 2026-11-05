// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * When `Hosting` may skip the frontend build during synth.
 *
 * `Hosting` runs its `buildCommand`, and the framework adapter runs its own
 * build (OpenNext, Nitro, Astro, SvelteKit), on every synth. Two synths don't
 * need a fresh build:
 *
 * - a synth that won't deploy the frontend: `npm run destroy` and
 *   `npm run sandbox:destroy` set {@link REUSE_FRONTEND_BUILD_CONTEXT}, so an
 *   existing build output is reused and a build runs only when there is none;
 * - a deploy the user asks to run on an existing build: {@link SKIP_FRONTEND_BUILD_ENV}
 *   set to `1`. Nothing is built, and a missing build output is an error. The
 *   build bakes the backend URL (`BLOCKS_API_URL`) into the frontend, so reuse
 *   is never automatic for a deploy.
 *
 * @module
 */

/** Env var that makes a deploy reuse the existing frontend build: `BLOCKS_SKIP_FRONTEND_BUILD=1`. */
export const SKIP_FRONTEND_BUILD_ENV = 'BLOCKS_SKIP_FRONTEND_BUILD';

/** CDK context key the destroy commands set: reuse an existing frontend build, build only when none exists. */
export const REUSE_FRONTEND_BUILD_CONTEXT = 'reuseFrontendBuild';

/**
 * How this synth treats the frontend build: `'required'` (reuse it, error if
 * it's missing), `'if-present'` (reuse it when it exists), or `undefined`
 * (build as usual). The env var wins over the context.
 */
export function frontendBuildReuse(
	contextValue: unknown,
	env: NodeJS.ProcessEnv = process.env,
): 'required' | 'if-present' | undefined {
	const flag = env[SKIP_FRONTEND_BUILD_ENV];
	if (flag === '1' || flag === 'true') return 'required';
	if (contextValue === true || contextValue === 'true') return 'if-present';
	return undefined;
}
