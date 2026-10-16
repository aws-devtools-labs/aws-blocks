// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The commands the dashboard tells a user to run.
 *
 * Centralised because they were wrong. Two pages instructed
 * `blocks deploy --stage <stage>`, which is not a command that exists anywhere:
 * the repo ships `bb-data`, `blocks-vendorize`, `blocks-generate-spec`,
 * `blocks-telemetry` and `create-blocks-app`, and no `blocks` binary at all. A
 * third page already said `npm run deploy` correctly, so the dashboard
 * contradicted itself page to page while telling someone their stage was not
 * deployed — they would copy the suggestion and get `command not found` on top
 * of the problem they came with.
 *
 * What the project templates actually define (7 of 8 — `amplify` defines
 * neither): `deploy` and `sandbox`. Only the `default` template defines
 * `dashboard`, which is why the copy about starting the dashboard is hedged
 * rather than asserted.
 */

/**
 * How to deploy the given stage, as a command a user can paste.
 *
 * The two stages map to two different scripts, which is the whole reason this
 * cannot be one constant: `sandbox` is the per-developer stack and `production`
 * is the shared one.
 */
export function deployCommandFor(stage: string): string {
	return stage === 'production' ? 'npm run deploy' : 'npm run sandbox';
}

/**
 * How the dashboard is started, phrased as an example rather than a fact.
 *
 * `npm run dashboard` exists only in the `default` template, so asserting it
 * would be wrong in most projects. What is always true is the requirement it
 * serves: the dashboard has to be launched by its own CLI, because that is what
 * mints the per-process session token the browser needs.
 */
export const START_DASHBOARD_HINT = 'start it from your project (e.g. npm run dashboard)';
