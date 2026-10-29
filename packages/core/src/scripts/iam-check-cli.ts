#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI for `checkCloudAssembly()` (see `iam-check.ts`). Exposed as the
 * `blocks-iam-check` bin entry on `@aws-blocks/core`, for a shared app
 * platform's pipeline to run after `cdk synth` and before the deploy gets AWS
 * credentials.
 *
 * Usage:
 *   blocks-iam-check [cdk.out] [--app <id>] [--json]
 *
 * - `cdk.out`  the cloud assembly directory (default `./cdk.out`).
 * - `--app`    the app id the pipeline expects, from its own registry — not a
 *              value the app's code chooses. Without it, the id in each report is used.
 * - `--json`   print the result as JSON.
 *
 * Exit codes: 0 no violations · 1 violations · 2 usage error.
 */

import { resolve } from 'node:path';
import { checkCloudAssembly, IamCheckUsageError } from './iam-check.js';

function usage(message?: string): never {
	if (message) process.stderr.write(`blocks-iam-check: ${message}\n`);
	process.stderr.write('Usage: blocks-iam-check [cdk.out] [--app <id>] [--json]\n');
	process.exit(2);
}

const args = process.argv.slice(2);
let dir = 'cdk.out';
let expectedApp: string | undefined;
let json = false;
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === '--app') {
		expectedApp = args[++i];
		if (!expectedApp) usage('--app needs a value.');
	} else if (arg === '--json') {
		json = true;
	} else if (arg === '--help' || arg === '-h') {
		usage();
	} else if (arg.startsWith('-')) {
		usage(`unknown option ${arg}.`);
	} else {
		dir = arg;
	}
}

try {
	const result = checkCloudAssembly(resolve(dir), expectedApp);
	if (json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else if (result.violations.length === 0) {
		process.stdout.write(
			`blocks-iam-check: no violations for app ${result.appIds.join(', ')} ` +
				`(${result.reports.length} report(s), ${result.templates.length} template(s)).\n`,
		);
	} else {
		process.stdout.write(`blocks-iam-check: ${result.violations.length} violation(s):\n`);
		for (const v of result.violations) process.stdout.write(`  • [${v.rule}] ${v.message}  (${v.source})\n`);
	}
	if (!json) for (const note of result.notes) process.stdout.write(`blocks-iam-check: note (not a violation): ${note}\n`);
	process.exit(result.violations.length === 0 ? 0 : 1);
} catch (error) {
	if (error instanceof IamCheckUsageError) usage(error.message);
	throw error;
}
