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

/** SDK error names for a request that AWS denied. */
const DENIAL_ERRORS: Record<string, true> = { AccessDenied: true, AccessDeniedException: true };

/**
 * The wording that AWS uses when an AWS Organizations policy explicitly denies a
 * request, for example "... is not authorized to perform: sts:AssumeRole ... with
 * an explicit deny in a service control policy". See "Troubleshoot access denied
 * error messages" in the IAM User Guide. A denial "because no service control
 * policy allows" an action is not an explicit deny and counts as `denied`.
 */
const ORGANIZATION_POLICY_DENY = /with an explicit deny in an? (?:service|resource) control policy/i;

/** Wording in CDK and CloudFormation output that shows a denied request. */
const DENIAL_IN_TEXT = /is not authorized to perform|\bAccessDenied(?:Exception)?\b|\bAccess Denied\b/;

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
	return ORGANIZATION_POLICY_DENY.test(error.message) ? 'organization-policy' : 'denied';
}

/**
 * Classify one piece of CDK or CloudFormation output, such as an error line or a
 * resource failure reason. Returns `undefined` when the text shows no denial.
 * The caller decides which text to pass; this does not track lines or chunks.
 */
export function classifyDenialText(text: string): DenialKind | undefined {
	if (ORGANIZATION_POLICY_DENY.test(text)) return 'organization-policy';
	return DENIAL_IN_TEXT.test(text) ? 'denied' : undefined;
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
