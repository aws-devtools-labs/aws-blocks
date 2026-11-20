// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `npm run typegen` — generate the type-safe key augmentation for `getSecret` /
 * `getConfig` in a CDK Blocks app. Statically scans the app's `secret('...')` /
 * `config('...')` calls (no execution, no AWS credentials) and writes a `.d.ts`
 * that narrows the runtime getters to your declared keys (autocomplete + typo
 * errors) with no call-site change.
 *
 * Thin pass-through to the `@aws-cdk-blocks/hosting` engine — the getters live on
 * `@aws-cdk-blocks/hosting`, so the generated file augments that module by default;
 * a CDK Blocks app needs no extra configuration.
 *
 * @module
 */

import { runTypegenCli as runHostingTypegenCli } from '@aws-cdk-blocks/hosting/scripts';
import { trackExitCode } from '../telemetry/trackCommand.js';

/**
 * Run the typegen CLI and send one `generate:types` event for the run (its
 * outcome from the exit code). Tracked here, not in the CLI, so an app still
 * running a vendored `aws-blocks/scripts/typegen.ts` sends it too. With
 * `--watch` the event is sent when the watcher ends, which is when `deps.signal`
 * is aborted, so a caller wires Ctrl-C (SIGINT) and SIGTERM
 * to that signal (as the `cdk-blocks` CLI and the `hosting-typegen` bin do) for
 * the event to be sent.
 */
export function runTypegenCli(argv: string[], deps?: Parameters<typeof runHostingTypegenCli>[1]): Promise<number> {
	return trackExitCode('generate:types', () => runHostingTypegenCli(argv, deps));
}
