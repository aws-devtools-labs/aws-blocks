// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-deploy AWS credential check.
 *
 * `cdk deploy` spends ~10 seconds synthesizing the app before it makes its
 * first AWS call, so a missing or expired credential surfaces only *after* that
 * wasted synth — as an opaque CDK/CloudFormation error that doesn't name the
 * real cause. Calling STS GetCallerIdentity up front turns that into an
 * immediate, actionable message the moment a deploy command starts.
 */

/**
 * Probe that resolves when valid AWS credentials are available and rejects
 * otherwise. Injectable so the guard can be unit-tested without network or real
 * credentials; production callers use the default {@link stsProbe}.
 */
export type CredentialProbe = () => Promise<void>;

/**
 * Default probe: STS GetCallerIdentity via the SDK's standard credential chain
 * (env vars, shared config/credentials, SSO, container/instance roles).
 *
 * Dynamically imported so the STS client is only loaded when a deploy actually
 * runs — never during dev-server startup or a mock unit test. A region is
 * always supplied (falling back to `us-east-1`) so the probe never fails for a
 * *missing region* — GetCallerIdentity is identity-only, so any region answers,
 * and region correctness is validated later by the deploy itself.
 */
const stsProbe: CredentialProbe = async () => {
	const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
	const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
	const client = new STSClient({ region });
	try {
		await client.send(new GetCallerIdentityCommand({}));
	} finally {
		client.destroy();
	}
};

/**
 * Fail fast when AWS credentials are unavailable or invalid, before a deploy
 * command spends time synthesizing.
 *
 * @param command - The npm script name, used in the error message (e.g. `sandbox`, `deploy`).
 * @param probe - Credential probe; defaults to STS GetCallerIdentity. Override in tests.
 * @throws {Error} With actionable guidance when the probe rejects.
 */
export async function assertAwsCredentials(command: string, probe: CredentialProbe = stsProbe): Promise<void> {
	try {
		await probe();
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`No valid AWS credentials found for \`npm run ${command}\`.\n` +
				'Configure credentials before deploying — for example:\n' +
				'  • run `aws configure` (or `aws sso login`), or\n' +
				'  • set AWS_PROFILE to a configured profile, or\n' +
				'  • export AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN for temporary credentials).\n' +
				`Then re-run \`npm run ${command}\`.\n` +
				`(underlying error: ${detail})`,
		);
	}
}
