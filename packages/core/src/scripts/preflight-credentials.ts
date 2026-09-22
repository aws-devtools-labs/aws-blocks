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
 * Resolve the region for the STS probe from the environment. Returns `null`
 * when neither `AWS_REGION` nor `AWS_DEFAULT_REGION` is set — the caller then
 * skips the probe rather than guessing a region, because a hardcoded guess
 * (e.g. `us-east-1`) belongs to a different **partition** than GovCloud
 * (`us-gov-*`) or China (`cn-*`) and would fail against a partition the user
 * isn't even deploying to.
 */
export function resolveProbeRegion(env: NodeJS.ProcessEnv = process.env): string | null {
	return env.AWS_REGION || env.AWS_DEFAULT_REGION || null;
}

/**
 * Probe that resolves when valid AWS credentials are available for `region` and
 * rejects otherwise. Injectable so the guard can be unit-tested without network
 * or real credentials; production callers use the default {@link stsProbe}.
 */
export type CredentialProbe = (region: string) => Promise<void>;

/**
 * Default probe: STS GetCallerIdentity via the SDK's standard credential chain
 * (env vars, shared config/credentials, SSO, container/instance roles).
 *
 * Dynamically imported so the STS client is only loaded when a deploy actually
 * runs — never during dev-server startup or a mock unit test. Bounded with a
 * short request timeout and a single attempt (matching `common/config.ts`) so a
 * bad network can't make this hang *longer* than the synth it's replacing.
 */
const stsProbe: CredentialProbe = async (region) => {
	const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
	const client = new STSClient({
		region,
		maxAttempts: 1,
		requestHandler: { connectionTimeout: 2000, requestTimeout: 3000 },
	});
	try {
		await client.send(new GetCallerIdentityCommand({}));
	} finally {
		client.destroy();
	}
};

/**
 * Verify AWS credentials before a deploy command spends time synthesizing, and
 * fail fast with actionable guidance when they're missing, expired, or invalid.
 *
 * Skips silently (with a warning) when no region can be resolved from the
 * environment, and treats network/service errors as non-fatal — see the module
 * doc for the rationale.
 *
 * @param command - The npm script name, used in the messages (e.g. `sandbox`, `deploy`).
 * @param probe - Credential probe; defaults to STS GetCallerIdentity. Override in tests.
 * @param env - Environment to resolve the region from. Defaults to `process.env`.
 * @throws {Error} With actionable guidance when the probe reports a credential error.
 */
export async function assertAwsCredentials(
	command: string,
	probe: CredentialProbe = stsProbe,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const region = resolveProbeRegion(env);
	if (!region) {
		console.warn(
			`⚠️  Skipping the AWS credential pre-check for \`npm run ${command}\`: ` +
				'no region set in AWS_REGION / AWS_DEFAULT_REGION. The deploy will surface any credential error itself.',
		);
		return;
	}

	try {
		await probe(region);
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
