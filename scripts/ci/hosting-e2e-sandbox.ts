// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Playwright `globalSetup` for the hosting E2E apps (test-apps/hosting-*/
// playwright.config.ts): deploys the app's sandbox once per `playwright test`
// run and returns the teardown that destroys it.
//
// The deploy used to run in each suite's `beforeAll`. A failed test ends its
// worker and its retry runs in a new one, which runs `beforeAll` again; the
// deploy script destroys the stack before deploying, so every retry destroyed
// the stack (about 4 min) and created a new one (about 4.5 min). A new stack is
// also what the suite's first requests race against, so the retry failed as
// often as the first attempt. Global setup runs once per run, so a retry reruns
// the test against the stack already deployed.
//
// Nothing is deployed unless BLOCKS_TEST_ENV is `sandbox`. With
// BLOCKS_SANDBOX_KEEP set the stack is kept, after a failed deploy too (CI's
// Destroy sandbox step deletes it).

import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import type { FullConfig } from '@playwright/test';

/** Run one of the app's `test/sandbox-*.ts` scripts in its own tsx process. */
function runSandboxScript(projectRoot: string, script: string): void {
	execFileSync('npx', ['tsx', script, join(projectRoot, 'aws-blocks', 'index.cdk.ts')], {
		cwd: projectRoot,
		stdio: 'inherit',
		env: { ...process.env, NODE_OPTIONS: '' },
	});
}

export default function globalSetup(config: FullConfig): (() => void) | undefined {
	if ((process.env.BLOCKS_TEST_ENV || 'local') !== 'sandbox') return undefined;
	if (!config.configFile) throw new Error('The hosting E2E sandbox setup needs a playwright.config.ts next to the app.');
	const projectRoot = dirname(config.configFile);
	const destroy = (): void => {
		if (process.env.BLOCKS_SANDBOX_KEEP) return;
		console.log('\n🗑️  Destroying sandbox...');
		runSandboxScript(projectRoot, 'test/sandbox-destroy.ts');
	};
	console.log(`🚀 Deploying ${basename(projectRoot)} sandbox...\n`);
	try {
		runSandboxScript(projectRoot, 'test/sandbox-deploy.ts');
	} catch (error) {
		// Playwright skips the returned teardown when setup throws.
		try {
			destroy();
		} catch (destroyError) {
			console.error(`Destroying the sandbox after the failed deploy failed too: ${String(destroyError)}`);
		}
		throw error;
	}
	return destroy;
}
