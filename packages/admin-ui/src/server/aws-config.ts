// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { fromIni } from '@aws-sdk/credential-providers';

/**
 * One place that decides which AWS identity and region every SDK client uses.
 *
 * Before this module the dashboard read `AWS_PROFILE` only to *display* it and
 * handed every client an empty config, so a `--profile` flag would have been a
 * lie: the SDK's ambient chain decided, and the reported profile could differ
 * from the credentials actually used. Now the profile is resolved to an explicit
 * `fromIni` provider, which is also what makes `awsContext.profile` truthful.
 *
 * The dashboard's own variables win over the ambient ones so a `--profile` on
 * the command line beats a stale `AWS_PROFILE` in the developer's shell.
 */

/** Set by the CLI from `--profile`. Beats AWS_PROFILE. */
export const PROFILE_ENV_VAR = 'BLOCKS_DASHBOARD_PROFILE';

/** Set by the CLI from `--region`. Beats AWS_REGION / AWS_DEFAULT_REGION. */
export const REGION_ENV_VAR = 'BLOCKS_DASHBOARD_REGION';

/** Credentials provider shape, taken from fromIni so no extra dependency is needed. */
export type CredentialsProvider = ReturnType<typeof fromIni>;

export interface AwsClientConfig {
	region?: string;
	credentials?: CredentialsProvider;
}

/**
 * The named profile in force, or undefined to let the SDK's ambient chain
 * decide (env credentials, SSO, container role, instance role).
 */
export function resolveProfile(): string | undefined {
	return firstNonEmpty(process.env[PROFILE_ENV_VAR], process.env.AWS_PROFILE);
}

/**
 * Tier 1: the region named on the dashboard's own command line (`--region`).
 *
 * Its own tier, above every other source, because it is an explicit statement of
 * which deployment the developer wants to look at. It used to share a tier with
 * `AWS_REGION` *below* the region recorded in the deploy history, which made the
 * flag unable to override a wrong recorded region — the exact situation a
 * developer reaches for `--region` to escape.
 */
export function resolveCliRegion(): string | undefined {
	return firstNonEmpty(process.env[REGION_ENV_VAR]);
}

/**
 * Tier 2: the ambient region from the environment.
 *
 * `AWS_DEFAULT_REGION` is honoured too — the AWS CLI writes it and the previous
 * code ignored it, which made the dashboard disagree with `aws` on the same box.
 */
export function resolveEnvRegion(): string | undefined {
	return firstNonEmpty(process.env.AWS_REGION, process.env.AWS_DEFAULT_REGION);
}

/**
 * Tiers 1 and 2 together: an explicitly stated region, from the flag or the
 * environment, with no per-stage knowledge.
 *
 * Callers that resolve a stage use `resolveStageRegion` instead, which puts a
 * stage's own CDK outputs document below these two. This one remains for the
 * genuinely stage-free calls (Cost Explorer, the doctor's credential probe).
 */
export function resolveAmbientRegion(): string | undefined {
	return firstNonEmpty(resolveCliRegion(), resolveEnvRegion());
}

/**
 * Cached per profile: fromIni reads and parses ~/.aws/config on each call, and
 * a single page render constructs several clients.
 */
const credentialCache = new Map<string, CredentialsProvider>();

/** Test seam — drops the memoized providers. */
export function resetCredentialCache(): void {
	credentialCache.clear();
}

function credentialsFor(profile: string): CredentialsProvider {
	const cached = credentialCache.get(profile);
	if (cached) return cached;
	const provider = fromIni({ profile });
	credentialCache.set(profile, provider);
	return provider;
}

/**
 * Config for any AWS SDK v3 client.
 *
 * @param region - Region resolved for the stage (from the deployment record).
 *                 When absent the ambient region is used, and when that is also
 *                 absent the key is omitted entirely so the SDK's own
 *                 resolution still applies rather than being pinned to a guess.
 */
export function awsClientConfig(region?: string): AwsClientConfig {
	const config: AwsClientConfig = {};
	const resolvedRegion = firstNonEmpty(region, resolveAmbientRegion());
	if (resolvedRegion) config.region = resolvedRegion;
	const profile = resolveProfile();
	if (profile) config.credentials = credentialsFor(profile);
	return config;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
	for (const value of values) {
		if (value !== undefined && value.trim() !== '') return value.trim();
	}
	return undefined;
}
