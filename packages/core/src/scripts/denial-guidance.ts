// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Classification and guidance for AWS authorization failures (access denied),
 * shared by the deploy commands. For internal use only.
 *
 * A failure reaches the deploy commands in two forms: an AWS SDK error, from a
 * call that the commands make themselves, or text, from the CDK CLI's output and
 * CloudFormation events (a failed CDK run is only a non-zero exit status). Both
 * forms are classified here with the same result.
 *
 * The result and the guidance never contain text from the failure, which can
 * contain account IDs, ARNs and policy IDs. The guidance adds to the failure and
 * never replaces it: callers keep the failure's outcome, and the CDK CLI's own
 * output is shown as before. Nothing here attributes a denial to a specific
 * policy or limit, because the error messages do not say which policy it is.
 */

/**
 * What a denial shows about its cause. `organization-policy` means that the
 * failure explicitly names a service control policy or a resource control policy
 * from AWS Organizations as the reason; any other access denied is `denied`.
 */
export type DenialKind = 'organization-policy' | 'denied';

/**
 * SDK error names for a request that AWS denied. Most services use `AccessDenied`
 * or `AccessDeniedException`; Amazon SNS uses `AuthorizationError` and Amazon EC2
 * uses `UnauthorizedOperation`.
 */
const DENIAL_ERRORS: Record<string, true> = {
	AccessDenied: true,
	AccessDeniedException: true,
	AuthorizationError: true,
	UnauthorizedOperation: true,
};

/**
 * The wording that AWS uses when an AWS Organizations policy explicitly denies a
 * request, for example "... is not authorized to perform: sts:AssumeRole ... with
 * an explicit deny in a service control policy". See "Troubleshoot access denied
 * error messages" in the IAM User Guide. A denial "because no service control
 * policy allows" an action is not an explicit deny and counts as `denied`.
 * Matched after {@link normalize}, so a single space stands for any whitespace.
 */
const ORGANIZATION_POLICY_DENY = /with an explicit deny in an? (?:service|resource) control policy/i;

/** Wording in CDK and CloudFormation output that shows a denied request, matched after {@link normalize}. */
const DENIAL_IN_TEXT =
	/not authorized to perform|\b(?:AccessDenied(?:Exception)?|AuthorizationError|UnauthorizedOperation)\b|\baccess denied\b/i;

/**
 * Terminal control sequences: colors and cursor movement (CSI) and window titles
 * or links (OSC), which the CDK CLI writes when it runs in a terminal.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const TERMINAL_CONTROLS = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * Example error names in the notes that the CDK CLI prints after a failed deploy,
 * for example "re-run `cdk diagnose` in a few minutes to check for additional
 * control-plane errors (e.g. AccessDenied)". They show no denial.
 */
const CDK_EXAMPLE_ERROR = /\(e\.g\. AccessDenied\)/gi;

/** Remove terminal control sequences from CLI output. */
export function stripTerminalControls(text: string): string {
	return text.replace(TERMINAL_CONTROLS, '');
}

/**
 * The text to match: without terminal control sequences, with each run of
 * whitespace (including line breaks, so that a phrase that the CDK CLI wrapped
 * across lines still matches) as one space, and without the CDK CLI's examples.
 */
function normalize(text: string): string {
	return stripTerminalControls(text).replace(/\s+/g, ' ').replace(CDK_EXAMPLE_ERROR, '');
}

/**
 * Classify an AWS SDK error. Only an SDK access-denied error is classified, so a
 * message that merely quotes a denial (for example in a credential provider or
 * a CDK process error) is not. Returns `undefined` when the error is not a denial.
 *
 * Use {@link classifyDenialText} for CDK and CloudFormation output instead: a
 * failed CDK run reaches the deploy commands as an exit status, not as an SDK error.
 */
export function classifyDenialError(error: unknown): DenialKind | undefined {
	if (!(error instanceof Error) || !Object.hasOwn(DENIAL_ERRORS, error.name)) return undefined;
	return ORGANIZATION_POLICY_DENY.test(normalize(error.message)) ? 'organization-policy' : 'denied';
}

/**
 * Classify one piece of CDK or CloudFormation output, such as an error line or a
 * resource failure reason. Returns `undefined` when the text shows no denial.
 * The caller decides which text to pass; this does not track lines or chunks.
 *
 * The text can span several lines: the CDK CLI hard-wraps the reason in its
 * error block, so pass the whole block to match a phrase that it split. Terminal
 * colors and CRLF line endings do not matter, and the CDK CLI's note that names
 * `AccessDenied` as an example of what `cdk diagnose` finds is not a denial.
 */
export function classifyDenialText(text: string): DenialKind | undefined {
	const normalized = normalize(text);
	if (ORGANIZATION_POLICY_DENY.test(normalized)) return 'organization-policy';
	return DENIAL_IN_TEXT.test(normalized) ? 'denied' : undefined;
}

/** The explanation and the next step for a denial, one line each, without details from the failure. */
export function denialGuidance(kind: DenialKind): string[] {
	if (kind === 'organization-policy') {
		return [
			'An AWS Organizations policy (a service control policy or a resource control policy) explicitly denies this request.',
			'Signing in again or adding IAM permissions does not change that. Ask the administrator of your AWS organization which actions the policy allows.',
		];
	}
	return [
		'The credentials do not have the permissions for this request.',
		'Check the permissions (IAM policies) of the role or user that you deploy with.',
	];
}
