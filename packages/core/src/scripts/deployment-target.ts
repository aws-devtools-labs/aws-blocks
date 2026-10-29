// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AwsCredentialIdentity } from '@smithy/types';

/** Options for the deployment target lookup. For internal use only. */
export interface DeploymentTargetOptions {
	env?: NodeJS.ProcessEnv;
	/** The directory where the CDK child process runs. */
	projectRoot?: string;
}

/** The Region and the CDK profile for a deployment. */
export interface DeploymentTarget {
	region: string | null;
	/**
	 * Set when `cdk.json` or `~/.cdk.json` sets a profile, or when only `AWS_DEFAULT_PROFILE`
	 * selects one. The SDK reads `AWS_PROFILE` itself.
	 */
	profile?: string;
	/**
	 * The `@aws-cdk/core:bootstrapQualifier` context value, if any: from `cdk.json`, then
	 * `cdk.context.json`, then `~/.cdk.json`, the order in which CDK looks it up.
	 */
	bootstrapQualifier?: string;
}

/** The context key that selects the CDK bootstrap resources for the default stack synthesizer. */
const BOOTSTRAP_QUALIFIER_CONTEXT = '@aws-cdk/core:bootstrapQualifier';

/** A Region code; any other value prints quoted or as a placeholder, so that it cannot write terminal control sequences. */
export const REGION_CODE = /^[a-z0-9-]+$/;

async function readCdkSettings(path: string): Promise<Record<string, unknown>> {
	try {
		const value: unknown = JSON.parse(await readFile(path, 'utf8'));
		if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { ...value };
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
	}
	// Do not show the path or the file contents. This error can go to telemetry.
	throw new Error('Could not read CDK configuration. Check cdk.json and ~/.cdk.json before deploying.');
}

/**
 * Read `cdk.context.json`. CDK rejects a malformed file itself, so here it only
 * means that the file sets no context.
 */
async function readCdkContext(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch {
		return undefined;
	}
}

/** The bootstrap qualifier in a context object, when it is a non-empty string. */
function contextQualifier(context: unknown): string | undefined {
	if (context === null || typeof context !== 'object') return undefined;
	const value: unknown = Reflect.get(context, BOOTSTRAP_QUALIFIER_CONTEXT);
	return typeof value === 'string' && value ? value : undefined;
}

/** The home directory, as the SDK and CDK find it. */
function homeDirectory(env: NodeJS.ProcessEnv): string {
	return (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir();
}

/** The paths of the shared AWS config and credentials files, as the SDK finds them. */
export function sharedConfigFiles(env: NodeJS.ProcessEnv = process.env): { configFilepath: string; filepath: string } {
	const home = homeDirectory(env);
	return {
		configFilepath: env.AWS_CONFIG_FILE ?? join(home, '.aws', 'config'),
		filepath: env.AWS_SHARED_CREDENTIALS_FILE ?? join(home, '.aws', 'credentials'),
	};
}

/**
 * Access keys from the environment, read as CDK reads them: each `AWS_` name, then
 * the `AMAZON_` name that CDK keeps for backward compatibility. SDK clients read
 * only the `AWS_` names. `undefined` unless both a key and a secret are set.
 */
export function environmentAccessKeys(env: NodeJS.ProcessEnv = process.env): AwsCredentialIdentity | undefined {
	const accessKeyId = env.AWS_ACCESS_KEY_ID || env.AMAZON_ACCESS_KEY_ID;
	const secretAccessKey = env.AWS_SECRET_ACCESS_KEY || env.AMAZON_SECRET_ACCESS_KEY;
	if (!accessKeyId || !secretAccessKey) return undefined;
	const sessionToken = env.AWS_SESSION_TOKEN ?? env.AMAZON_SESSION_TOKEN;
	return sessionToken ? { accessKeyId, secretAccessKey, sessionToken } : { accessKeyId, secretAccessKey };
}

/**
 * Find the Region and the profile that CDK uses for a deployment.
 *
 * The lookup order is:
 * 1. `region` in `cdk.json`, then `region` in `~/.cdk.json`.
 * 2. `AWS_REGION`, `AMAZON_REGION`, `AWS_DEFAULT_REGION`, then `AMAZON_DEFAULT_REGION`. CDK keeps
 *    the `AMAZON` prefix for backward compatibility.
 * 3. The `region` of the selected profile, then the `region` of the `default` profile.
 *
 * A `profile` in `cdk.json` or `~/.cdk.json` selects the profile. If there is no
 * such setting, `AWS_PROFILE` selects it, then `AWS_DEFAULT_PROFILE`.
 *
 * This function does not use a fixed fallback Region. A fixed Region can be in a
 * different partition, for example GovCloud or China. If no Region is set, the
 * function returns `null`.
 *
 * This function does not change `env`, and it does not get credentials.
 */
export async function resolveDeploymentTarget({
	env = process.env,
	projectRoot = process.cwd(),
}: DeploymentTargetOptions = {}): Promise<DeploymentTarget> {
	const home = homeDirectory(env);
	const [userSettings, projectSettings, projectContext] = await Promise.all([
		readCdkSettings(join(home, '.cdk.json')),
		readCdkSettings(join(projectRoot, 'cdk.json')),
		readCdkContext(join(projectRoot, 'cdk.context.json')),
	]);
	const settings = { ...userSettings, ...projectSettings };
	const settingsProfile = typeof settings.profile === 'string' && settings.profile ? settings.profile : undefined;
	const envProfile = env.AWS_PROFILE || env.AWS_DEFAULT_PROFILE;
	// CDK and the AWS CLI read AWS_DEFAULT_PROFILE, but SDK v3 clients do not, so pass it
	// explicitly. CDK uses access keys from the environment before an environment profile.
	const hasEnvKeys = environmentAccessKeys(env) !== undefined;
	const passDefaultProfile = !env.AWS_PROFILE && !hasEnvKeys && Boolean(env.AWS_DEFAULT_PROFILE);
	const profile = settingsProfile ?? (passDefaultProfile ? env.AWS_DEFAULT_PROFILE : undefined);
	const qualifier =
		contextQualifier(projectSettings.context) ??
		contextQualifier(projectContext) ??
		contextQualifier(userSettings.context);
	const bootstrapQualifier = qualifier ? { bootstrapQualifier: qualifier } : {};
	const cdkRegion = typeof settings.region === 'string' && settings.region ? settings.region : null;
	const region =
		cdkRegion || env.AWS_REGION || env.AMAZON_REGION || env.AWS_DEFAULT_REGION || env.AMAZON_DEFAULT_REGION;
	if (region) return { region, profile, ...bootstrapQualifier };

	const { loadSharedConfigFiles } = await import('@smithy/shared-ini-file-loader');
	const { configFile, credentialsFile } = await loadSharedConfigFiles({
		...sharedConfigFiles(env),
		ignoreCache: true,
	});
	const selectedProfile = settingsProfile || envProfile || 'default';
	// CDK reads the credentials file before the config file.
	return {
		region:
			credentialsFile[selectedProfile]?.region ??
			configFile[selectedProfile]?.region ??
			credentialsFile.default?.region ??
			configFile.default?.region ??
			null,
		profile,
		...bootstrapQualifier,
	};
}
