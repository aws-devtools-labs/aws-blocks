// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs with the `tsx` loader, started by `npm run dashboard`. The options come
 * from `process.argv[2]` and carry `argv` explicitly: core parses the dashboard's
 * own flags out of `DashboardOptions.argv`, and this runner's real argv holds the
 * options JSON and `--telemetry-file`, which are not dashboard flags.
 */

import * as core from '@aws-blocks/core/scripts';
import { asPromptInterruption, exitWithError } from './fail.js';

const options = JSON.parse(process.argv[2]) as core.DashboardOptions;

try {
	await core.dashboard(options);
} catch (error) {
	// Ctrl-C at core's admin-ui install prompt is the operator stopping the command, not a failure.
	exitWithError(asPromptInterruption(error));
}
