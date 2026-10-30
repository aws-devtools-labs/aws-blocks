// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The result of the last successful deploy of each stage, as the deploy runner
 * saw it. Only the runner knows it:
 * - Core's deploy loads `.env.production` (and the sandbox `.env.local`) into the
 *   runner's own environment, so only the runner knows the account and
 *   credentials CDK deployed with.
 * - The stack outputs come from the outputs core read when it deployed. A
 *   sandbox and the production deploy of the same app share
 *   `.blocks-sandbox/outputs.json`, and CDK rewrites it with only the stacks of
 *   the command that wrote it, so after the runner exits it can hold the other
 *   stage's stack alone.
 *
 * After a successful deploy the runner writes its stage's entry to
 * `.blocks-sandbox/last-deploy.json`; the CLI reads that entry for the
 * `--output json` result, instead of asking AWS with its own, possibly
 * different, environment, or reading `outputs.json` again.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type * as CoreScriptsModule from '@aws-blocks/core/scripts';

export const LAST_DEPLOY_FILE = join('.blocks-sandbox', 'last-deploy.json');

export type DeployStage = 'production' | 'sandbox';

/** The stack a deploy deployed, from the outputs core read when it deployed. */
export interface DeployedOutputs {
	stack: string;
	apiUrl: string;
	/** The frontend URL; null without a hosted frontend. */
	url: string | null;
}

export interface LastDeploy extends DeployedOutputs {
	account: string | null;
	region: string | null;
	/** The credentials label, for example `AWS profile prod`. */
	credentials: string;
}

type Core = Pick<typeof CoreScriptsModule, 'readAwsIdentity' | 'describeDeploymentCredentials'>;

type LastDeployFile = Partial<Record<DeployStage, LastDeploy>>;

function readFile(projectRoot: string): LastDeployFile {
	try {
		return JSON.parse(readFileSync(join(projectRoot, LAST_DEPLOY_FILE), 'utf-8')) as LastDeployFile;
	} catch {
		return {};
	}
}

/** Replace one stage's entry, keeping the other's; a rename, so a reader never sees half a file. */
function writeEntry(projectRoot: string, stage: DeployStage, entry: LastDeploy | undefined): void {
	const path = join(projectRoot, LAST_DEPLOY_FILE);
	const file = readFile(projectRoot);
	if (entry === undefined && file[stage] === undefined) return;
	file[stage] = entry;
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`);
	renameSync(temporary, path);
}

/**
 * Record a successful deploy of `stage`: its outputs, and the target that `env`
 * (the runner's environment after the deploy) resolves to.
 */
export async function recordLastDeploy(
	projectRoot: string,
	stage: DeployStage,
	deployed: DeployedOutputs,
	invocation: string,
	core: Core,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	let target: Pick<LastDeploy, 'account' | 'region' | 'credentials'>;
	try {
		const identity = await core.readAwsIdentity({ invocation, env, projectRoot });
		target = { account: identity.account ?? null, region: identity.region, credentials: identity.credentials };
	} catch {
		const described = await core.describeDeploymentCredentials({ env, projectRoot });
		target = { account: null, region: described.region, credentials: described.credentials };
	}
	writeEntry(projectRoot, stage, { ...deployed, ...target });
}

/** The last successful deploy of `stage` in `projectRoot`, if one was recorded. */
export function readLastDeploy(projectRoot: string, stage: DeployStage): LastDeploy | undefined {
	return readFile(projectRoot)[stage];
}

/** Remove the entry of `stage`, before a new deploy of it, so that a failed one leaves none. */
export function forgetLastDeploy(projectRoot: string, stage: DeployStage): void {
	writeEntry(projectRoot, stage, undefined);
}
