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
 * portal cannot be reached, and keeps that error only as text in its message. For
 * a `CredentialsProviderError`, the message is therefore read to find one of the
 * network error names above, and the label is then that name. The label never
 * contains message text, which can contain the caller ARN and account ID.
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

/** A credential failure found in CDK CLI output: the error name to print, and how the credentials failed. */
export interface CredentialFailureInText {
	errorName: string;
	failure: Extract<CredentialFailure, 'expired' | 'rejected'>;
	/**
	 * The text is the sign-in instruction of an AWS SDK credential provider (IAM
	 * Identity Center or `aws login`). It wraps the error that stopped the provider,
	 * which can be an `AccessDeniedException` from the sign-in service, so such
	 * text is a credential failure even when it quotes a denial.
	 */
	fromProvider?: boolean;
}

/**
 * Error names for expired or rejected credentials, matched only where CDK CLI
 * output names an error: as `<Name>:` at the start of a message or after `‣`, in
 * an `Error Code:` field, and after `Assuming role failed:`. A resource or file
 * named like one is not a failure. `RequestExpired` is left out: Amazon EC2 also
 * returns it for a request whose time is more than 15 minutes off.
 */
const CREDENTIAL_ERROR_NAMES =
	'ExpiredToken(?:Exception)?|TokenRefreshRequired|InvalidClientTokenId|UnrecognizedClientException';
const CREDENTIAL_ERROR_IN_TEXT = new RegExp(
	`(?:^\\s*|‣\\s*)(${CREDENTIAL_ERROR_NAMES}):|(?:Error ?Code:|Assuming role failed:)\\s*(${CREDENTIAL_ERROR_NAMES})\\b`,
);

/**
 * The sign-in instructions of the AWS SDK credential providers that the CDK CLI
 * bundles: IAM Identity Center (SSO) sessions and tokens, and `aws login`
 * sessions, including a failed refresh ("Failed to refresh token: <error>.
 * Please re-authenticate using aws login").
 */
const CREDENTIAL_PROVIDER_WORDING: ReadonlyArray<[RegExp, CredentialFailureInText]> = [
	[
		/SSO session associated with this profile (?:has expired|is invalid)/i,
		{ errorName: 'CredentialsProviderError', failure: 'expired', fromProvider: true },
	],
	[
		/Token is expired\. To refresh this SSO session/i,
		{ errorName: 'TokenProviderError', failure: 'expired', fromProvider: true },
	],
	[
		/Your session has expired\. Please reauthenticate|Please re-authenticate using `?aws login/i,
		{ errorName: 'CredentialsProviderError', failure: 'expired', fromProvider: true },
	],
];

/** AWS's wording, without an error name, for an expired or invalid security token. */
const CREDENTIAL_SERVICE_WORDING: ReadonlyArray<[RegExp, CredentialFailureInText]> = [
	[/security token included in the request is expired/i, { errorName: 'ExpiredToken', failure: 'expired' }],
	[/security token included in the request is invalid/i, { errorName: 'InvalidClientTokenId', failure: 'rejected' }],
];

/**
 * Find a credential failure in a piece of CDK CLI output, such as a failed asset
 * upload or the cause in its error block. Returns `undefined` when the text shows
 * none. A credential provider's sign-in instruction comes first (see
 * {@link CredentialFailureInText.fromProvider}); then an error name, classified
 * with {@link classifyCredentialError}; then AWS's wording. The result never
 * contains text from the failure.
 */
export function classifyCredentialFailureText(text: string): CredentialFailureInText | undefined {
	const normalized = text.replace(/\s+/g, ' ');
	const provider = CREDENTIAL_PROVIDER_WORDING.find(([wording]) => wording.test(normalized));
	if (provider) return provider[1];
	const named = CREDENTIAL_ERROR_IN_TEXT.exec(normalized);
	if (named) {
		const errorName = named[1] ?? named[2];
		const failure = classifyCredentialError(errorName);
		if (failure === 'expired' || failure === 'rejected') return { errorName, failure };
	}
	return CREDENTIAL_SERVICE_WORDING.find(([wording]) => wording.test(normalized))?.[1];
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
			/**
			 * `environment-role` is a role assumed with the access keys in the environment
			 * (`credential_source = Environment`); `workload` is a role assumed with the
			 * container or instance role.
			 */
			type:
				| 'none'
				| 'static'
				| 'sso'
				| 'login'
				| 'process'
				| 'web-identity'
				| 'workload'
				| 'environment-role'
				| 'unknown';
			/** The selected profile. */
			profile: string;
			/** The profile that holds the credentials when `profile` assumes a role with `source_profile`. */
			sourceProfile?: string;
			/** The `region` setting of the profile that holds the credentials (`sourceProfile`, or else `profile`). */
			region?: string;
			/**
			 * Whether that `region` comes from the credentials file, where it overrides the
			 * config file that `aws configure set` writes.
			 */
			regionInCredentialsFile?: boolean;
	  };

type Profiles = Record<string, Record<string, string | undefined> | undefined>;
type ProfileSourceType = Exclude<CredentialSource['type'], 'environment' | 'missing-profile'>;

/** Settings that make the SDK treat a profile as an SSO profile (`isSsoProfile`). */
const SSO_SETTINGS = ['sso_start_url', 'sso_account_id', 'sso_session', 'sso_region', 'sso_role_name'] as const;

/**
 * Follow `source_profile` to the profile that holds the credentials, in the order
 * of the SDK's shared-config provider. The SDK's separate SSO provider runs only
 * when the client is configured with SSO settings, which the deploy clients are not.
 *
 * This mirrors `resolveProfileData` in `@aws-sdk/credential-provider-ini`; keep the
 * two in step when the SDK changes. A mismatch changes only the printed hint:
 * whether the check fails comes from the SDK error name.
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
		if (!data.source_profile) {
			if (data.credential_source === 'Environment') return { type: 'environment-role' };
			const workload =
				data.credential_source === 'EcsContainer' || data.credential_source === 'Ec2InstanceMetadata';
			return { type: workload ? 'workload' : 'unknown' };
		}
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
	// SSO wins over login_session, as in the SDK.
	if (SSO_SETTINGS.some((key) => data[key] !== undefined)) return { type: 'sso' };
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
	const { loadSharedConfigFiles } = await import('@smithy/shared-ini-file-loader');
	const { configFile, credentialsFile } = await loadSharedConfigFiles({
		...sharedConfigFiles(env),
		ignoreCache: true,
	});
	// As in the SDK and the AWS CLI, a setting in the credentials file overrides the same setting in the config file.
	const profiles: Profiles = {};
	for (const file of [configFile, credentialsFile]) {
		for (const [key, values] of Object.entries(file)) profiles[key] = { ...profiles[key], ...values };
	}
	/** The Region of the profile that holds the credentials, and the file that sets it. */
	const regionOf = (holder: string) => ({
		region: profiles[holder]?.region,
		...(credentialsFile[holder]?.region !== undefined && { regionInCredentialsFile: true }),
	});
	const source = profileSource(profiles, name, new Set());
	if (source.type !== 'none') {
		return { ...source, profile: name, ...regionOf(source.sourceProfile ?? name) };
	}
	if (selected && !profiles[name]) return { type: 'missing-profile', profile: name };
	if (env.AWS_WEB_IDENTITY_TOKEN_FILE && env.AWS_ROLE_ARN) return { type: 'web-identity' };
	if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI) {
		return { type: 'workload' };
	}
	return { ...source, profile: name, ...regionOf(name) };
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
export function profileName(profile: string): string {
	return SHELL_SAFE_PROFILE.test(profile) ? profile : JSON.stringify(profile);
}

/**
 * A profile argument for a printed command. A name that a shell could interpret
 * (`$(…)`, backticks, spaces, quotes) prints as a `<profile>` placeholder, so a
 * copied command never runs anything else. The message names the profile elsewhere.
 */
export function profileArg(profile: string): string {
	return SHELL_SAFE_PROFILE.test(profile) ? profile : '<profile>';
}

/** `aws login` for `profile`; `regionArg` adds `--region`, which overrides the Region in the environment and the profile. */
function loginCommand(profile: string, support: AwsCliLoginSupport, regionArg?: string): string {
	const command = `aws login --profile ${profileArg(profile)}${regionArg ? ` --region ${regionArg}` : ''}`;
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

/** A deployment Region for the message: as given, as prose, and as a command argument. */
interface PrintedRegion {
	value: string;
	name: string;
	arg: string;
	/**
	 * Whether `AWS_REGION` or `AWS_DEFAULT_REGION` names another Region. The AWS CLI
	 * uses them before the profile's Region, so `aws login` then needs `--region`.
	 */
	pin: boolean;
}

/** Region names, as in `us-east-1` or `us-gov-west-1`. Any other value prints as a placeholder in commands. */
const SHELL_SAFE_REGION = /^[a-z]{2}(?:-[a-z0-9]+)+$/;

/**
 * The lines that recommend `aws login --profile <profile>`, after `prefix`.
 *
 * `aws login` signs in to the Region of the profile, and asks for one when the
 * profile has none. When that is not the deployment Region, the lines first set
 * the profile's Region, and say to sign in again after any later change, so that
 * the sign-in and the deployment use the same Region. A Region in the credentials
 * file overrides the config file that `aws configure set` writes, so the lines then
 * ask to change it there. When the environment names another Region, which the AWS
 * CLI would use instead, the command adds `--region`.
 */
function signInLines(
	prefix: string,
	profile: string,
	login: AwsCliLoginSupport,
	region: PrintedRegion | undefined,
	profileRegion: { region?: string; regionInCredentialsFile?: boolean } | undefined,
): string[] {
	const regionArg = region?.pin ? region.arg : undefined;
	const signIn = `${prefix}${loginCommand(profile, login, regionArg)}`;
	if (!region || profileRegion?.region === region.value) return [signIn];
	const named = profileName(profile);
	const arg = profileArg(profile);
	return [
		profileRegion?.regionInCredentialsFile
			? `Before you sign in, set the Region of profile ${named} to ${region.name} in your AWS credentials file, which overrides aws configure.`
			: `Before you sign in, set the Region of profile ${named} to ${region.name}: aws configure set region ${region.arg} --profile ${arg}`,
		signIn,
		`If you change the Region of profile ${named} later, sign in again: ${loginCommand(profile, 'supported', regionArg)}`,
	];
}

/**
 * The explanation and the fix, one line each. `login` is set when the fix is `aws login`,
 * and `region` is the deployment Region.
 */
function guidanceLines(
	source: CredentialSource,
	failure: CredentialFailure,
	login: AwsCliLoginSupport,
	region: PrintedRegion | undefined,
): string[] {
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
			...signInLines('Sign in to create it: ', source.profile, login, region, undefined),
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
			if (failure === 'unavailable') {
				lines.push(
					`No AWS credentials are configured for profile ${named}.`,
					`New to AWS? Create an account: ${SIGN_UP_URL}`,
					...signInLines('Already have an account? Sign in: ', profile, login, region, source),
					`Other ways to sign in: ${SIGN_IN_OPTIONS_URL}`,
				);
				break;
			}
			// Something outside the AWS config files supplied credentials, for example an instance role.
			lines.push(
				failure === 'expired'
					? `The credentials for profile ${named} have expired.`
					: `AWS did not accept the credentials for profile ${named}.`,
				'They are not in your AWS config files, so they come from another source, such as an instance role.',
				...signInLines('Check that source, or sign in: ', profile, login, region, source),
				`Other ways to sign in: ${SIGN_IN_OPTIONS_URL}`,
			);
			break;
		case 'login':
			lines.push(
				`The AWS sign-in session for profile ${named} has expired or could not be refreshed.`,
				...signInLines('Sign in again: ', profile, login, region, source),
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
		case 'environment-role': {
			const variables = 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY';
			lines.push(
				`Profile ${named} assumes a role with the access keys in ${variables}.`,
				failure === 'expired'
					? 'Those temporary credentials have expired.'
					: failure === 'rejected'
						? 'AWS did not accept those access keys.'
						: 'Those variables are not set.',
				`Export valid credentials in ${variables}, or select another profile.`,
			);
			break;
		}
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
	/** The deployment Region. The message names it, and `aws login` guidance sets the profile to it first. */
	region?: string;
	/**
	 * The command keeps running (`npm run sandbox` in `cdk watch`), so the last line
	 * says how the fix reaches it instead of asking to re-run it; see {@link watchNextStep}.
	 */
	watching?: boolean;
}

/**
 * Credential sources whose credentials expire and that the CDK CLI loads again
 * when they do, reading the AWS config and the SSO or sign-in token cache again,
 * so a running `cdk watch` uses them after the user signs in again.
 */
const RELOADED_SOURCES: Record<string, true> = {
	sso: true,
	login: true,
	'web-identity': true,
	workload: true,
	none: true,
};

/**
 * The last line of the message while `cdk watch` runs. `cdk watch` stays running
 * after a failed deploy and deploys again on the next file change. The CDK CLI
 * caches credentials until they expire, and caches credentials without an expiry
 * (access keys in the environment or a profile, most `credential_process` output)
 * for the life of the process, so those need a restart of the command. A
 * profile that assumes a role with `source_profile` gets role credentials with
 * an expiry, which the CDK CLI requests again, reading the profiles again, so
 * it picks up fixed source credentials too.
 */
function watchNextStep(command: string, source: CredentialSource | undefined): string {
	const assumesRole = source !== undefined && 'sourceProfile' in source && source.sourceProfile !== undefined;
	if (source && (assumesRole || Object.hasOwn(RELOADED_SOURCES, source.type))) {
		return 'Then save a file in the project: `cdk watch` deploys again with the new credentials.';
	}
	return `Then stop \`npm run ${command}\` (Ctrl-C) and run it again: the running watch keeps the credentials that it loaded.`;
}

/**
 * Build the message for a credential failure. The message names the source and
 * the command that fixes it. If the source cannot be determined, for example
 * because a module fails to load, the message lists the general ways to
 * configure credentials instead. Unreadable or malformed AWS config files do not
 * reach this fallback: the SDK's loader reads them as empty.
 *
 * The message also names the profile and the deployment Region. When the fix is
 * `aws login` and the profile is set to another Region, or to none, it first
 * prints the `aws configure set region` command that sets the deployment Region.
 * When `AWS_REGION` or `AWS_DEFAULT_REGION` names another Region (for example
 * because `cdk.json` sets the Region), the `aws login` command adds `--region`.
 *
 * The last line asks to re-run the command, or with `watching`, says whether
 * saving a file or restarting the command picks up the fixed credentials.
 */
export async function credentialFailureMessage({
	command,
	errorName,
	failure,
	env = process.env,
	profile,
	readAwsCliVersion: read = readAwsCliVersion,
	region,
	watching = false,
}: CredentialFailureMessageOptions): Promise<string> {
	const cliRegion = env.AWS_REGION || env.AWS_DEFAULT_REGION;
	const pin = Boolean(cliRegion) && cliRegion !== region;
	const printed: PrintedRegion | undefined =
		region === undefined
			? undefined
			: SHELL_SAFE_REGION.test(region)
				? { value: region, name: region, arg: region, pin }
				: { value: region, name: JSON.stringify(region), arg: '<region>', pin };
	const inRegion = printed ? ` in Region ${printed.name}` : '';
	let lines: string[];
	let source: CredentialSource | undefined;
	try {
		source = await describeCredentialSource(env, profile);
		const login =
			source.type === 'none' || source.type === 'login' || source.type === 'missing-profile'
				? await awsCliLoginSupport(read)
				: 'unknown';
		const target =
			'profile' in source && source.profile !== undefined
				? `Using profile ${profileName(source.profile)}${inRegion}.`
				: printed && `Using Region ${printed.name}.`;
		lines = [...(target ? [target] : []), ...guidanceLines(source, failure, login, printed)];
	} catch {
		lines = [
			...(printed ? [`Using Region ${printed.name}.`] : []),
			'Configure AWS credentials, for example:',
			'  • run `aws login`, `aws sso login` or `aws configure`, or',
			'  • set AWS_PROFILE to a configured profile, or',
			'  • export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN for temporary credentials).',
		];
	}
	return [
		`AWS credentials could not be verified for \`npm run ${command}\` (${errorName}).`,
		...lines.map((line) => `  ${line}`),
		watching ? watchNextStep(command, source) : `Then re-run \`npm run ${command}\`.`,
	].join('\n');
}
