// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The deployment target that a deploy runner actually used. Core's deploy loads
 * `.env.production` (and the sandbox `.env.local`) into the runner's own
 * environment, so only the runner knows the account and credentials CDK deployed
 * with. After a successful deploy it writes them to `.blocks-sandbox/last-deploy.json`;
 * the CLI reads that file for the `--output json` result instead of asking AWS
 * with its own, possibly different, environment.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type * as CoreScriptsModule from '@aws-blocks/core/scripts';

export const LAST_DEPLOY_FILE = join('.blocks-sandbox', 'last-deploy.json');

export interface DeployTarget {
	account: string | null;
	region: string | null;
	/** The credentials label, for example `AWS profile prod`. */
	credentials: string;
}

type Core = Pick<typeof CoreScriptsModule, 'readAwsIdentity' | 'describeDeploymentCredentials'>;

/** Write the target that `env` (the runner's environment after the deploy) resolves to. */
export async function recordDeployTarget(
	projectRoot: string,
	invocation: string,
	core: Core,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	let target: DeployTarget;
	try {
		const identity = await core.readAwsIdentity({ invocation, env, projectRoot });
		target = { account: identity.account ?? null, region: identity.region, credentials: identity.credentials };
	} catch {
		const described = await core.describeDeploymentCredentials({ env, projectRoot });
		target = { account: null, region: described.region, credentials: described.credentials };
	}
	const path = join(projectRoot, LAST_DEPLOY_FILE);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(target, null, 2)}\n`);
}

/** The target the last successful deploy in `projectRoot` recorded, if any. */
export function readDeployTarget(projectRoot: string): DeployTarget | undefined {
	try {
		return JSON.parse(readFileSync(join(projectRoot, LAST_DEPLOY_FILE), 'utf-8')) as DeployTarget;
	} catch {
		return undefined;
	}
}
