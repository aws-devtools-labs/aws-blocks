// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scope } from '../common/index.js';

/**
 * The client-generation step of `deploy()`: generate `client.js` for the
 * deployed backend, and populate this process's Scope BB registry so the
 * `deploy` telemetry event reports the app's blocks.
 *
 * The backend is imported ONLY in a child process under
 * `--conditions=aws-runtime` — never in-process. An in-process import resolves
 * every Building Block to its local MOCK layer, and mocks start long-lived local
 * runtimes (the PGlite engine behind `Database`, `CronJob` schedulers, …) whose
 * ref'd handles kept the deploy CLI alive forever after a successful deploy.
 * The worker hands its registry back as JSON; registry failures are swallowed
 * (telemetry is best-effort), client-generation failures are not.
 *
 * @param foundationPath - Absolute path to the backend definition (`aws-blocks/index.ts`).
 * @param clientPath - Where to write the generated client.
 */
export async function generateDeployClient(foundationPath: string, clientPath: string): Promise<void> {
	const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'generate-client-worker.js');
	const registryDir = mkdtempSync(join(tmpdir(), 'blocks-registry-'));
	const registryPath = join(registryDir, 'registry.json');
	try {
		execFileSync(
			'node',
			['--conditions=aws-runtime', '--import', 'tsx', workerPath, foundationPath, clientPath, registryPath],
			{
				stdio: 'inherit',
				env: { ...process.env, NODE_OPTIONS: '' },
			},
		);
		try {
			Scope._mergeRegistry(JSON.parse(readFileSync(registryPath, 'utf-8')));
		} catch {
			// best-effort — telemetry never affects the command
		}
	} finally {
		rmSync(registryDir, { recursive: true, force: true });
	}
}
