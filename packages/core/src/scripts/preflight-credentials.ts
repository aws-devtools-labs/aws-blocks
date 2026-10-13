// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { type DeploymentTargetOptions, resolveDeploymentTarget } from './deployment-target.js';

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
 */

/**
 * Error `name`s that mean the credentials themselves are missing, expired, or
 * invalid — the cases where the "configure your credentials" remediation is
 * correct. Anything else (network, throttling, an explicit `AccessDenied` — which
 * actually proves the identity resolved) is surfaced as itself instead.
 */
const CREDENTIAL_ERROR_NAMES = new Set([
	'CredentialsProviderError',
	'ExpiredToken',
	'ExpiredTokenException',
	'InvalidClientTokenId',
	'UnrecognizedClientException',
	'SignatureDoesNotMatch',
	'TokenRefreshRequired',
]);

/**
 * Probe that resolves when valid AWS credentials are available for `region` and
 * rejects otherwise. Injectable so the guard can be unit-tested without network
 * or real credentials; production callers use the default {@link stsProbe}.
 */
export type CredentialProbe = (region: string, profile?: string) => Promise<void>;

/**
 * Default probe: STS GetCallerIdentity via the SDK's standard credential chain
 * (env vars, shared config/credentials, SSO, container/instance roles).
 *
 * Dynamically imported so the STS client is only loaded when a deploy actually
 * runs — never during dev-server startup or a mock unit test. Bounded with a
 * short request timeout and a single attempt (matching `common/config.ts`) so a
 * bad network can't make this hang *longer* than the synth it's replacing.
 */
const stsProbe: CredentialProbe = async (region, profile) => {
	const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
	const client = new STSClient({
		region,
		profile,
		maxAttempts: 1,
		requestHandler: { connectionTimeout: 2000, requestTimeout: 3000 },
	});
	try {
		await client.send(new GetCallerIdentityCommand({}));
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
}

/**
 * Verify AWS credentials before a deploy command spends time synthesizing, and
 * fail fast with actionable guidance when they're missing, expired, or invalid.
 *
 * The check uses the Region and the profile from {@link resolveDeploymentTarget}.
 * If no Region is set, the check shows a warning and does not send a request.
 * Network and service errors are not fatal; see the module doc.
 *
 * @throws {Error} With actionable guidance when the probe reports a credential error,
 * or when the CDK configuration cannot be read.
 */
export async function assertAwsCredentials({
	command,
	probe = stsProbe,
	...options
}: AssertAwsCredentialsOptions): Promise<void> {
	const { region, profile } = await resolveDeploymentTarget(options);
	if (!region) {
		console.warn(
			`⚠️  Skipping the AWS credential pre-check for \`npm run ${command}\`: no Region is set. ` +
				'Set AWS_REGION, or set region in your AWS profile. The deploy will surface any credential error itself.',
		);
		return;
	}

	try {
		await probe(region, profile);
	} catch (error) {
		// Use the error *name* only — never the raw message, which for an STS
		// authorization failure embeds the caller ARN and account id (and this
		// Error propagates through telemetry).
		const name = error instanceof Error && error.name ? error.name : 'UnknownError';

		if (CREDENTIAL_ERROR_NAMES.has(name)) {
			throw new Error(
				`AWS credentials could not be verified for \`npm run ${command}\` (${name}).\n` +
					'Configure AWS credentials — for example:\n' +
					'  • run `aws configure` (or `aws sso login`), or\n' +
					'  • set AWS_PROFILE to a configured profile, or\n' +
					'  • export AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN for temporary credentials).\n' +
					`Then re-run \`npm run ${command}\`.`,
			);
		}

		// Not a credential problem (network, throttling, STS disabled in-region, …).
		// Don't block a deploy that might still work — warn and continue.
		console.warn(
			`⚠️  Could not verify AWS credentials for \`npm run ${command}\` (${name}); ` +
				'continuing — the deploy will report any real error.',
		);
	}
}
