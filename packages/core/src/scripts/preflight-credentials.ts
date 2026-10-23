// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AwsCredentialIdentity } from '@smithy/types';
import { type AccountMetadata, type AccountMetadataClientFactory, readAccountMetadata } from './account-metadata.js';
import {
	type AwsCliVersionReader,
	classifyCredentialError,
	credentialErrorLabel,
	credentialFailureMessage,
	describeCredentialSource,
	profileArg,
	profileName,
} from './credential-guidance.js';
import { type DeploymentTargetOptions, environmentAccessKeys, resolveDeploymentTarget } from './deployment-target.js';

/**
 * Pre-deploy AWS credential check.
 *
 * `cdk deploy` spends ~10 seconds synthesizing the app before it makes its
 * first AWS call, so a missing or expired credential surfaces only *after* that
 * wasted synth — as an opaque CDK/CloudFormation error that doesn't name the
 * real cause. Calling STS GetCallerIdentity up front turns that into an
 * immediate, actionable message the moment a deploy command starts.
 *
 * The check is intentionally conservative: it fails fast **only** on a real
 * credential problem (missing/expired/invalid). A network or service error
 * (STS unreachable, throttled, disabled in a region) is not treated as a
 * credential failure — it warns and lets the deploy proceed, since blocking on
 * an unverifiable probe would reject a deploy that might have worked.
 *
 * On a credential failure, the message names the credential source (for example
 * an SSO or `aws login` profile, or access keys in the environment) and the
 * command that fixes it. The check never prompts, signs in, or changes credentials.
 *
 * Before the deploy continues, the check prints the deployment target: the
 * credentials that CDK deploys with (a profile, environment access keys or
 * workload credentials) and the configured Region. With verified credentials it
 * also reads the account name and the AWS account plan, which are optional: any
 * failure only makes them unavailable. When the caller's role is the AWS-managed
 * role of the new AWS sign-up experience, it then links to the AWS Settings billing page, where those
 * accounts set their spend limit, and asks the user to check that the project
 * selected there is the deployment target. The Region is the configured one, not discovered.
 *
 * CDK deploys with access keys from the environment before `AWS_PROFILE`; only a
 * `profile` in `cdk.json` or `~/.cdk.json` overrides them. SDK clients do the
 * opposite when `AWS_PROFILE` is set, so the check passes those keys explicitly.
 * Otherwise it would verify and describe a different account from the deploy.
 */

/**
 * Probe that resolves when valid AWS credentials are available for `region` and
 * rejects otherwise. Injectable so the guard can be unit-tested without network
 * or real credentials; production callers use the default {@link stsProbe}.
 *
 * `environmentKeys` are the access keys from the environment when CDK deploys
 * with them; the probe then verifies those instead of running the credential chain.
 * The probe may resolve to the credentials it verified and the caller ARN. Only
 * then are the account name, plan and role read, with those same credentials.
 */
export type CredentialProbe = (
	region: string,
	profile?: string,
	environmentKeys?: AwsCredentialIdentity,
) => Promise<VerifiedCredentials | undefined>;

/** What a {@link CredentialProbe} verified. */
export interface VerifiedCredentials {
	credentials: AwsCredentialIdentity;
	/** The caller ARN from STS GetCallerIdentity. Used only to find the caller's role; never printed. */
	callerArn?: string;
}

/**
 * Default probe: STS GetCallerIdentity via the SDK's standard credential chain
 * (env vars, shared config/credentials, SSO, container/instance roles).
 *
 * Dynamically imported so the STS client is only loaded when a deploy actually
 * runs — never during dev-server startup or a mock unit test. Bounded with a
 * short request timeout and a single attempt (matching `common/config.ts`) so a
 * bad network can't make this hang *longer* than the synth it's replacing.
 *
 * Resolves to the credentials that the request was signed with, so that the
 * metadata reads use the same identity, and to the caller ARN. The default
 * credential chain runs once, as a client for this profile and Region would run
 * it, and the request is signed with that snapshot. Reading a client's credential
 * provider a second time is not a cache hit: the SDK refreshes credentials that
 * expire within five minutes, which can run `credential_process` or an MFA prompt
 * again and return another identity.
 */
const stsProbe: CredentialProbe = async (region, profile, environmentKeys) => {
	const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
	const config = {
		region,
		profile,
		maxAttempts: 1,
		requestHandler: { connectionTimeout: 2000, requestTimeout: 3000 },
	};
	let credentials = environmentKeys;
	if (!credentials) {
		const chain = new STSClient(config);
		try {
			credentials = await chain.config.credentials();
		} finally {
			chain.destroy();
		}
	}
	const client = new STSClient({ ...config, credentials });
	try {
		const { Arn } = await client.send(new GetCallerIdentityCommand({}));
		return { credentials, callerArn: Arn };
	} finally {
		client.destroy();
	}
};

/** Options for {@link assertAwsCredentials}. */
export interface AssertAwsCredentialsOptions extends DeploymentTargetOptions {
	/** The npm script name, used in the messages (e.g. `sandbox`, `deploy`). */
	command: string;
	/** Credential probe; defaults to STS GetCallerIdentity. Override in tests. */
	probe?: CredentialProbe;
	/** Reads `aws --version` when the guidance recommends `aws login`. Override in tests. */
	readAwsCliVersion?: AwsCliVersionReader;
	/** Creates the clients for the optional account name and plan reads. Override in tests. */
	metadataClients?: AccountMetadataClientFactory;
	/** How long the optional metadata reads may take, in milliseconds. Override in tests. */
	metadataTimeoutMs?: number;
	/**
	 * Read and print the account name and plan, and the billing link. Default `true`.
	 * The destroy commands turn it off and print only the deployment target.
	 */
	accountDetails?: boolean;
}

const BILLING_URL = 'https://settings.aws.com/billing';
const PROJECTS_URL = 'https://settings.aws.com/projects';

/** A Region code; any other value prints quoted, so that it cannot write terminal control sequences. */
const REGION_CODE = /^[a-z0-9-]+$/;

const NO_METADATA: AccountMetadata = { accountName: null, plan: null, managedRole: false };

/** How the summary names the deploy credentials, and the profile that the `aws login` advice is for. */
interface CredentialsLabel {
	text: string;
	profile?: string;
}

async function credentialsLabel(
	env: NodeJS.ProcessEnv,
	profile: string | undefined,
	environmentKeys: AwsCredentialIdentity | undefined,
): Promise<CredentialsLabel> {
	if (environmentKeys) {
		const variable = env.AWS_ACCESS_KEY_ID ? 'AWS_ACCESS_KEY_ID' : 'AMAZON_ACCESS_KEY_ID';
		const ignored = env.AWS_PROFILE ? 'AWS_PROFILE' : env.AWS_DEFAULT_PROFILE ? 'AWS_DEFAULT_PROFILE' : undefined;
		return { text: `access keys in ${variable}${ignored ? ` (used instead of ${ignored})` : ''}` };
	}
	const selected = profile || env.AWS_PROFILE;
	if (selected) return { text: `AWS profile ${profileName(selected)}`, profile: selected };
	// Nothing selects a profile, so the SDK tries the default profile and then the environment.
	const source = await describeCredentialSource(env).catch(() => undefined);
	if (source?.type === 'web-identity' && !source.profile) return { text: 'a web identity role from AWS_ROLE_ARN' };
	if (source?.type === 'workload' && !source.profile) return { text: 'container credentials' };
	if (source?.type === 'none') return { text: 'the default credential chain', profile: 'default' };
	return { text: 'AWS profile default', profile: 'default' };
}

/**
 * The deployment target, then the optional metadata unless `metadata` is `null`.
 * The spend-limit guidance follows only for the AWS-managed sign-in role: AWS
 * Settings manages spend limits for those accounts, not for other accounts. The
 * Region is the configured one; nothing here claims that it is the Region of the
 * user's project.
 */
function targetSummary(credentials: CredentialsLabel, region: string | null, metadata: AccountMetadata | null): string {
	const regionLabel = region ? (REGION_CODE.test(region) ? region : JSON.stringify(region)) : 'not set';
	const target = `🎯 Deployment target: ${credentials.text}, Region ${regionLabel}`;
	if (!metadata) return target;
	return [
		target,
		`   Account name: ${metadata.accountName ?? 'not available'}`,
		`   Account plan: ${metadata.plan ?? 'not available'}`,
		...(metadata.managedRole
			? [`💳 Spend limit: ${BILLING_URL} (check that the project selected there matches this target)`]
			: []),
	].join('\n');
}

/**
 * Verify AWS credentials before a deploy command spends time synthesizing, and
 * fail fast with actionable guidance when they're missing, expired, or invalid.
 *
 * The check uses the Region and the profile from {@link resolveDeploymentTarget},
 * and the access keys from the environment when CDK deploys with them.
 * If no Region is set, the check shows a warning and does not send a request.
 * Network and service errors are not fatal; see the module doc. The AWS CLI
 * version is checked only after a credential failure, so it never blocks valid
 * credentials.
 *
 * When the deploy continues, the check prints the deployment target. When the
 * probe returns the credentials it verified, the check first reads the optional
 * account name, plan and caller role with them, within a short timeout, and adds
 * the AWS Settings billing link for the AWS-managed sign-in role. Those reads
 * never throw or block the deploy. With `accountDetails: false` it prints only
 * the deployment target.
 *
 * @throws {Error} With actionable guidance when the probe reports a credential error,
 * or when the CDK configuration cannot be read.
 */
export async function assertAwsCredentials({
	command,
	probe = stsProbe,
	readAwsCliVersion,
	metadataClients,
	metadataTimeoutMs,
	accountDetails = true,
	...options
}: AssertAwsCredentialsOptions): Promise<void> {
	const env = options.env ?? process.env;
	const { region, profile } = await resolveDeploymentTarget(options);
	// CDK deploys with access keys from the environment unless cdk.json selects a profile;
	// with environment keys, resolveDeploymentTarget returns only that setting as `profile`.
	const environmentKeys = profile ? undefined : environmentAccessKeys(env);
	const target = await credentialsLabel(env, profile, environmentKeys);
	if (!region) {
		console.warn(
			[
				`⚠️  Skipping the AWS credential pre-check for \`npm run ${command}\`: no Region is set. ` +
					'Set AWS_REGION, or set region in your AWS profile. The deploy will surface any credential error itself.',
				...(target.profile
					? [
							"   For `aws login`: before you run `aws login`, set the profile Region to your project's Region " +
								`(listed at ${PROJECTS_URL}):`,
							`     aws configure set region <region> --profile ${profileArg(target.profile)}`,
							'   If you change the profile Region after you sign in, run `aws login` again.',
						]
					: []),
			].join('\n'),
		);
		console.log(targetSummary(target, null, accountDetails ? NO_METADATA : null));
		return;
	}

	let verified: VerifiedCredentials | undefined;
	try {
		verified = await probe(region, profile, environmentKeys);
	} catch (error) {
		// The label is the error name, a Node.js error code, or a known network error
		// name found in a credential provider's message; never message text, which for
		// an STS authorization failure embeds the caller ARN and account id (and this
		// Error propagates through telemetry).
		const label = credentialErrorLabel(error);
		const failure = classifyCredentialError(label);

		// Not a credential problem: don't block a deploy that might still work.
		if (failure === 'network') {
			console.warn(
				`⚠️  Could not reach AWS to verify credentials for \`npm run ${command}\` (${label}); ` +
					'continuing — if the deploy also fails to connect, check your network or proxy settings.',
			);
		} else if (failure === 'inconclusive') {
			console.warn(
				`⚠️  Could not verify AWS credentials for \`npm run ${command}\` (${label}); ` +
					'continuing — the deploy will report any real error.',
			);
		} else {
			throw new Error(
				await credentialFailureMessage({
					command,
					errorName: label,
					failure,
					// The guidance follows the deploy: with environment keys, no profile is used, and
					// the keys are passed under the AWS_ names that the guidance reads.
					env: environmentKeys
						? {
								...env,
								AWS_PROFILE: undefined,
								AWS_DEFAULT_PROFILE: undefined,
								AWS_ACCESS_KEY_ID: environmentKeys.accessKeyId,
								AWS_SECRET_ACCESS_KEY: environmentKeys.secretAccessKey,
								AWS_SESSION_TOKEN: environmentKeys.sessionToken,
							}
						: env,
					profile,
					readAwsCliVersion,
				}),
			);
		}
	}

	if (!accountDetails) {
		console.log(targetSummary(target, region, null));
		return;
	}
	const metadata = verified
		? await readAccountMetadata(
				{ region, profile, credentials: verified.credentials, callerArn: verified.callerArn },
				{ clients: metadataClients, timeoutMs: metadataTimeoutMs },
			)
		: NO_METADATA;
	console.log(targetSummary(target, region, metadata));
}
