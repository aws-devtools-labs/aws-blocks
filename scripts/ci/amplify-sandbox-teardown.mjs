#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Deletes an Amplify Gen 2 sandbox, retrying until the delete succeeds or the
// budget runs out. Runs in the `if: always()` cleanup step of
// .github/workflows/e2e-amplify-interop.yml.
//
// Usage: node scripts/ci/amplify-sandbox-teardown.mjs <app-dir> <identifier>
//
// `ampx sandbox delete` fails when CloudFormation gives up on a resource. The
// usual cause is the sandbox's REST API: API Gateway allows about one REST API
// delete per 30 seconds per account, CI jobs and other PRs share that quota,
// and CloudFormation stops retrying a throttled delete after about 4.5 minutes,
// leaving the stack DELETE_FAILED with all its resources in place. Running the
// delete again later resumes it, so each failed attempt is retried after a
// backoff with jitter (parallel jobs that failed together retry apart).
//
// An attempt that starts before the deadline runs to completion; the step's
// timeout-minutes is the backstop. When the budget runs out the sandbox is left
// to the scheduled sweep in cleanup-stacks.yml, with a warning: a throttled
// teardown is infrastructure contention, not a failure of the PR under test.
//
// Env: AMPLIFY_TEARDOWN_BUDGET_SECONDS (default 600),
// AMPLIFY_TEARDOWN_BACKOFF_MS (first backoff, default 30000; doubles up to 4x),
// AMPLIFY_TEARDOWN_JITTER_MS (random extra wait, default 30000).

import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const [appDir, identifier] = process.argv.slice(2);
if (!appDir || !identifier) {
	console.error('Usage: node scripts/ci/amplify-sandbox-teardown.mjs <app-dir> <identifier>');
	process.exit(2);
}
const deadline = Date.now() + Number(process.env.AMPLIFY_TEARDOWN_BUDGET_SECONDS ?? 600) * 1000;
const backoffMs = Number(process.env.AMPLIFY_TEARDOWN_BACKOFF_MS ?? 30_000);
const jitterMs = Number(process.env.AMPLIFY_TEARDOWN_JITTER_MS ?? 30_000);

for (let attempt = 1; ; attempt++) {
	console.log(`Deleting Amplify sandbox "${identifier}" (attempt ${attempt})`);
	const r = spawnSync('npm', ['run', 'sandbox:delete', '--', '--identifier', identifier], {
		cwd: appDir,
		stdio: 'inherit',
	});
	if (r.status === 0) {
		console.log(`Deleted Amplify sandbox "${identifier}"`);
		process.exit(0);
	}
	const wait = backoffMs * 2 ** Math.min(attempt - 1, 2) + Math.floor(Math.random() * jitterMs);
	if (Date.now() + wait >= deadline) {
		console.log(
			`::warning title=Amplify sandbox teardown::sandbox "${identifier}" not deleted after ${attempt} attempt(s); ` +
				'the scheduled stack sweep (cleanup-stacks.yml) retries it',
		);
		process.exit(0);
	}
	console.log(`Delete failed (exit ${r.status ?? r.signal}); retrying in ${Math.round(wait / 1000)}s`);
	await sleep(wait);
}
