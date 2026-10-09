// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sharedConfigFiles } from './deployment-target.js';

const execFileAsync = promisify(execFile);

/**
 * Credential diagnostics for the deploy commands. For internal use only.
 *
 * The guidance names where the credentials come from (environment, profile type)
 * and the profile, and prints the command that fixes that source. It never
 * contains a raw SDK error message or a value from the AWS config files: those
 * can hold account IDs, role ARNs and credential commands, and the error can
 * reach telemetry. Nothing here prompts, signs in, or changes credentials.
 */

/** How the credentials failed, from the SDK error name. These failures stop the deploy. */
export type CredentialFailure = 'expired' | 'rejected' | 'unavailable';

/**
 * The outcome of a failed credential check. `network` means that AWS could not be
 * reached. Neither it nor `inconclusive` proves that the deploy will fail, so they
 * do not stop it.
 */
export type CredentialCheckFailure = CredentialFailure | 'network' | 'inconclusive';

/**
 * Error `name`s that mean the credentials themselves are missing, expired, or
 * invalid, the cases where a sign-in or configuration fix is correct.
 */
const CREDENTIAL_FAILURES: Record<string, CredentialFailure> = {
	CredentialsProviderError: 'unavailable',
	ExpiredToken: 'expired',
	ExpiredTokenException: 'expired',
	TokenRefreshRequired: 'expired',
	InvalidClientTokenId: 'rejected',
	UnrecognizedClientException: 'rejected',
	SignatureDoesNotMatch: 'rejected',
};

/** SDK error names, and Node.js error codes, for a request that did not reach AWS or got no response. */
const NETWORK_ERRORS: Record<string, true> = {
	TimeoutError: true,
	RequestTimeout: true,
	RequestTimeoutException: true,
	NetworkingError: true,
	ECONNREFUSED: true,
	ECONNRESET: true,
	ENOTFOUND: true,
	EAI_AGAIN: true,
	ETIMEDOUT: true,
	EHOSTUNREACH: true,
	ENETUNREACH: true,
};

const NETWORK_ERROR_IN_MESSAGE = new RegExp(`\\b(${Object.keys(NETWORK_ERRORS).join('|')})\\b`);

/**
 * A printable label for an error from the credential check: the SDK error name,
 * or the Node.js error code for a network error, whose name is only `Error`.
 * A credential provider wraps the error that stopped it, for example when the SSO
 * portal cannot be reached; the label is then that network error. Never the
 * message, which can contain the caller ARN and account ID.
 */
export function credentialErrorLabel(error: unknown): string {
	if (!(error instanceof Error) || !error.name) return 'UnknownError';
	if (error.name === 'Error' && 'code' in error && typeof error.code === 'string' && /^E[A-Z_]+$/.test(error.code)) {
		return error.code;
	}
	if (error.name === 'CredentialsProviderError') {
		const network = NETWORK_ERROR_IN_MESSAGE.exec(error.message);
		if (network) return network[1];
	}
	return error.name;
}

/** Classify a label from {@link credentialErrorLabel}. */
export function classifyCredentialError(label: string): CredentialCheckFailure {
	if (Object.hasOwn(CREDENTIAL_FAILURES, label)) return CREDENTIAL_FAILURES[label];
	if (Object.hasOwn(NETWORK_ERRORS, label)) return 'network';
	return 'inconclusive';
}

/** Where the SDK gets the deployment credentials. */
export type CredentialSource =
	/** Access keys in `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. */
	| { type: 'environment' }
	/** The selected profile is not in the config or credentials file. */
	| { type: 'missing-profile'; profile: string }
	/** A role from `AWS_WEB_IDENTITY_TOKEN_FILE`, or container credentials, with no credentials in the profile. */
	| { type: 'web-identity' | 'workload'; profile?: undefined }
	| {
			type: 'none' | 'static' | 'sso' | 'login' | 'process' | 'web-identity' | 'workload' | 'unknown';
			/** The selected profile. */
			profile: string;
			/** The profile that holds the credentials when `profile` assumes a role with `source_profile`. */
			sourceProfile?: string;
	  };

type Profiles = Record<string, Record<string, string | undefined> | undefined>;
type ProfileSourceType = Exclude<CredentialSource['type'], 'environment' | 'missing-profile'>;

/**
 * Follow `source_profile` to the profile that holds the credentials, in the order
 * of the SDK's shared-config provider. The SDK's separate SSO provider runs only
 * when the client is configured with SSO settings, which the deploy clients are not.
 */
function profileSource(
	profiles: Profiles,
	name: string,
	visited: Set<string>,
): { type: ProfileSourceType; sourceProfile?: string } {
	const data = profiles[name] ?? {};
	// A source profile's own access keys win over its other settings.
	if (visited.size > 0 && data.aws_access_key_id) return { type: 'static' };
	if (data.role_arn && (data.source_profile || data.credential_source)) {
		if (!data.source_profile) return { type: 'workload' };
		const source = data.source_profile;
		visited.add(name);
		// A cycle is an error, except for a profile that assumes a role with its own keys.
		if (visited.has(source) && !profiles[source]?.aws_access_key_id) return { type: 'unknown' };
		const root = profileSource(profiles, source, visited);
		return { type: root.type, sourceProfile: root.sourceProfile ?? (source === name ? undefined : source) };
	}
	if (data.aws_access_key_id) return { type: 'static' };
	if (data.role_arn && data.web_identity_token_file) return { type: 'web-identity' };
	if (data.credential_process) return { type: 'process' };
	if (data.sso_session || data.sso_start_url) return { type: 'sso' };
	if (data.login_session) return { type: 'login' };
	return { type: data.role_arn ? 'unknown' : 'none' };
}

/**
 * Find where the SDK gets credentials for a deployment, in the order of its
 * default credential chain. `profile` is the profile passed to the SDK client;
 * otherwise the SDK uses `AWS_PROFILE`. When a profile is selected, the SDK
 * does not use access keys from the environment.
 */
export async function describeCredentialSource(
	env: NodeJS.ProcessEnv = process.env,
	profile?: string,
): Promise<CredentialSource> {
	const selected = profile || env.AWS_PROFILE;
	if (!selected && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return { type: 'environment' };

	const name = selected || 'default';
	// Loaded on demand, like the STS client, so that this module adds nothing to dev-server startup.
	const { parseKnownFiles } = await import('@smithy/shared-ini-file-loader');
	const profiles: Profiles = await parseKnownFiles({ ...sharedConfigFiles(env), ignoreCache: true });
	const source = profileSource(profiles, name, new Set());
	if (source.type !== 'none') return { ...source, profile: name };
	if (selected && !profiles[name]) return { type: 'missing-profile', profile: name };
	if (env.AWS_WEB_IDENTITY_TOKEN_FILE && env.AWS_ROLE_ARN) return { type: 'web-identity' };
	if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI) {
		return { type: 'workload' };
	}
	return { ...source, profile: name };
}

/** Whether the installed AWS CLI has `aws login`, which needs version 2.32.0 or later. */
export type AwsCliLoginSupport = 'supported' | 'upgrade' | 'install' | 'unknown';

/** Returns the output of `aws --version`. Injectable so tests do not run the AWS CLI. */
export type AwsCliVersionReader = () => Promise<string>;

/** Default reader: run `aws --version` with a short timeout. AWS CLI v1 prints the version to stderr. */
export const readAwsCliVersion: AwsCliVersionReader = async () => {
	const { stdout, stderr } = await execFileAsync('aws', ['--version'], { timeout: 2000, windowsHide: true });
	return `${stdout}\n${stderr}`;
};

/** Check the AWS CLI version. Never throws: an unreadable version is `unknown`. */
export async function awsCliLoginSupport(read: AwsCliVersionReader = readAwsCliVersion): Promise<AwsCliLoginSupport> {
	let output: string;
	try {
		output = await read();
	} catch (error) {
		const notFound = error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
		return notFound ? 'install' : 'unknown';
	}
	const match = /aws-cli\/(\d+)\.(\d+)\.\d+/.exec(output);
	if (!match) return 'unknown';
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 2 || (major === 2 && minor >= 32) ? 'supported' : 'upgrade';
}

const SIGN_UP_URL = 'https://signin.aws.amazon.com/signup?request_type=builderId';
const CLI_INSTALL_URL = 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html';
const SIGN_IN_OPTIONS_URL = 'https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-authentication.html';

/** Profile names that need no quoting in POSIX shells, cmd or PowerShell, and that cannot be read as an option. */
const SHELL_SAFE_PROFILE = /^\w[\w.@+-]*$/;

/** A profile name for prose; quoted, with control characters escaped, when it has unusual characters. */
function profileName(profile: string): string {
	return SHELL_SAFE_PROFILE.test(profile) ? profile : JSON.stringify(profile);
}

/**
 * A profile argument for a printed command. A name that a shell could interpret
 * (`$(…)`, backticks, spaces, quotes) prints as a `<profile>` placeholder, so a
 * copied command never runs anything else. The message names the profile elsewhere.
 */
function profileArg(profile: string): string {
	return SHELL_SAFE_PROFILE.test(profile) ? profile : '<profile>';
}

function loginCommand(profile: string, support: AwsCliLoginSupport): string {
	const command = `aws login --profile ${profileArg(profile)}`;
	switch (support) {
		case 'supported':
			return command;
		case 'upgrade':
			return `${command}  (first update the AWS CLI to version 2.32.0 or later: ${CLI_INSTALL_URL})`;
		case 'install':
			return `${command}  (first install the AWS CLI, version 2.32.0 or later: ${CLI_INSTALL_URL})`;
		case 'unknown':
			return `${command}  (needs AWS CLI version 2.32.0 or later)`;
	}
}

/** The explanation and the fix, one line each. `login` is set when the fix is `aws login`. */
function guidanceLines(source: CredentialSource, failure: CredentialFailure, login: AwsCliLoginSupport): string[] {
	if (source.type === 'environment') {
		const variables = 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY';
		const fix = `Export new credentials, or unset ${variables} to use an AWS profile.`;
		if (failure === 'expired') return [`The temporary credentials in ${variables} have expired.`, fix];
		return [`AWS did not accept the access key in ${variables}.`, fix];
	}
	if (source.type === 'missing-profile') {
		const profile = profileName(source.profile);
		return [
			`Profile ${profile} is not in your AWS config or credentials file.`,
			`Sign in to create it: ${loginCommand(source.profile, login)}`,
			'Or select another profile with AWS_PROFILE, or with "profile" in cdk.json.',
			`New to AWS? Create an account: ${SIGN_UP_URL}`,
		];
	}
	if (source.profile === undefined) {
		return source.type === 'web-identity'
			? [
					'The web identity token in AWS_WEB_IDENTITY_TOKEN_FILE did not give valid credentials.',
					'Check the token file and the role in AWS_ROLE_ARN.',
				]
			: [
					'The container credentials for this environment did not give valid credentials.',
					'Check the role that is attached to this environment.',
				];
	}

	const lines: string[] = [];
	const profile = source.sourceProfile ?? source.profile;
	const named = profileName(profile);
	const arg = profileArg(profile);
	if (source.sourceProfile) {
		lines.push(`Profile ${profileName(source.profile)} assumes a role with credentials from profile ${named}.`);
	}
	switch (source.type) {
		case 'none':
			lines.push(
				`No AWS credentials are configured for profile ${named}.`,
				`New to AWS? Create an account: ${SIGN_UP_URL}`,
				`Already have an account? Sign in: ${loginCommand(profile, login)}`,
				`Other ways to sign in: ${SIGN_IN_OPTIONS_URL}`,
			);
			break;
		case 'login':
			lines.push(
				`The AWS sign-in session for profile ${named} has expired or could not be refreshed.`,
				`Sign in again: ${loginCommand(profile, login)}`,
			);
			break;
		case 'sso':
			lines.push(
				`The IAM Identity Center (SSO) session for profile ${named} has expired or is not valid.`,
				`Sign in again: aws sso login --profile ${arg}`,
			);
			break;
		case 'static':
			if (failure === 'expired') {
				lines.push(
					`The temporary credentials for profile ${named} have expired.`,
					'Replace them with new credentials from the tool that issued them.',
				);
			} else {
				lines.push(
					failure === 'rejected'
						? `AWS did not accept the access key for profile ${named}.`
						: `The access key for profile ${named} is incomplete.`,
					`Update it: aws configure --profile ${arg}`,
				);
			}
			break;
		case 'process':
			lines.push(
				`The credential_process command for profile ${named} did not give valid credentials.`,
				'Check that command, or sign in with the tool that it runs.',
			);
			break;
		case 'web-identity':
			lines.push(
				`The web identity token for profile ${named} did not give valid credentials.`,
				'Check the token file and the role in that profile.',
			);
			break;
		case 'workload':
			lines.push(
				`The role credentials that profile ${named} gets from this environment are not valid.`,
				'Check the role that is attached to this environment.',
			);
			break;
		case 'unknown':
			lines.push(
				`The credentials for profile ${named} could not be loaded.`,
				`Check the profile, or see the ways to sign in: ${SIGN_IN_OPTIONS_URL}`,
			);
			break;
	}
	return lines;
}

/** Input for {@link credentialFailureMessage}. */
export interface CredentialFailureMessageOptions {
	/** The npm script name, used in the message (for example `sandbox` or `deploy`). */
	command: string;
	/** The SDK error name. The message includes it for debugging. */
	errorName: string;
	failure: CredentialFailure;
	env?: NodeJS.ProcessEnv;
	/** The profile passed to the SDK client, if any. */
	profile?: string;
	/** Reads `aws --version`; called only when the guidance recommends `aws login`. */
	readAwsCliVersion?: AwsCliVersionReader;
}

/**
 * Build the message for a credential failure. The message names the source and
 * the command that fixes it. If the AWS config files cannot be read, the message
 * lists the general ways to configure credentials instead.
 */
export async function credentialFailureMessage({
	command,
	errorName,
	failure,
	env = process.env,
	profile,
	readAwsCliVersion: read = readAwsCliVersion,
}: CredentialFailureMessageOptions): Promise<string> {
	let lines: string[];
	try {
		const source = await describeCredentialSource(env, profile);
		const login =
			source.type === 'none' || source.type === 'login' || source.type === 'missing-profile'
				? await awsCliLoginSupport(read)
				: 'unknown';
		lines = guidanceLines(source, failure, login);
	} catch {
		lines = [
			'Configure AWS credentials, for example:',
			'  • run `aws login`, `aws sso login` or `aws configure`, or',
			'  • set AWS_PROFILE to a configured profile, or',
			'  • export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN for temporary credentials).',
		];
	}
	return [
		`AWS credentials could not be verified for \`npm run ${command}\` (${errorName}).`,
		...lines.map((line) => `  ${line}`),
		`Then re-run \`npm run ${command}\`.`,
	].join('\n');
}
