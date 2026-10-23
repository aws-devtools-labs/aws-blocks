// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one place a federation callback's OAuth `error` / `error_description` is
 * turned into a client answer (FX60), shared by both engines that read one:
 * `federation-hosted-ui.ts` (Cognito managed login's own text) and
 * `federation-direct.ts` (the external IdP's).
 *
 * Both used to quote that text in the `IdpErrorException` they throw, and
 * `ApiError.message` crosses the RPC wire verbatim and is what the
 * `<Authenticator>` shows — so a redirect chose the words the app answered
 * with. That contradicted FX59 (R93, the port of `AuthCognito` #678): every
 * other engine error already reaches the client as a fixed, block-authored
 * message per error name, its own text logged server-side only. The callbacks
 * now take the same route: {@link idpRefusedMessage} is all the client gets,
 * and {@link maskIdpCallbackError} logs `error` / `error_description`.
 *
 * Neither path is injectable: both run only after the returned `state` has been
 * matched against this browser's pending-auth cookie (R2-2), so only the IdP
 * the sign-in actually went to can reach them. Masking the text is defence in
 * depth on top of that — an IdP's own operational detail (an internal
 * endpoint, a Cognito trigger ARN, the login it echoes) is for the operator,
 * not for the page.
 *
 * Server-only (`ChildLogger`, and `error-mapping.ts`'s AWS-identifier test).
 *
 * @internal
 */

import type { ChildLogger } from '@aws-blocks/bb-logger';
import { AWS_IDENTIFIER_PATTERN } from '../error-mapping.js';

/**
 * OAuth error codes that mean the provider faulted rather than refused — the
 * callback equivalent of FX59's "5xx name" (RFC 6749 §4.1.2.1). Everything else
 * (`access_denied`, `invalid_request`, `invalid_scope`, OIDC's
 * `login_required` …) is an ordinary outcome of one sign-in attempt.
 */
const IDP_FAULT_CODES: ReadonlySet<string> = new Set(['server_error', 'temporarily_unavailable']);

/**
 * The fixed, block-authored message a client gets when a federation callback
 * carries an OAuth error. Names the provider — the app's own config key, so the
 * user knows which button failed — and nothing the IdP sent.
 *
 * @internal
 */
export function idpRefusedMessage(providerId: string): string {
	return `The identity provider '${providerId}' refused the sign-in.`;
}

/**
 * Log a callback's `error` / `error_description` and return the message to
 * throw. Follows FX59's logging in `error-mapping.ts`: `error` for a provider
 * fault ({@link IDP_FAULT_CODES}) or text naming AWS resources — both are an
 * operator's problem — and `info` otherwise, since a user who declines the
 * consent screen is not a fault.
 *
 * Nothing is redacted: a federation callback has no login to redact against
 * (the user is not identified until the code is redeemed), and the line never
 * leaves the server.
 *
 * @param log - The block's logger.
 * @param logMessage - The log line's text, so each engine names its own hop.
 * @param detail - The provider id and the callback's `error` / `error_description`.
 * @returns The fixed message for the `IdpErrorException` to carry.
 *
 * @internal
 */
export function maskIdpCallbackError(
	log: ChildLogger,
	logMessage: string,
	detail: { provider: string; error: string; description: string | null },
): string {
	const fault = IDP_FAULT_CODES.has(detail.error) || AWS_IDENTIFIER_PATTERN.test(detail.description ?? '');
	const line = { provider: detail.provider, error: detail.error, description: detail.description };
	if (fault) log.error(logMessage, line);
	else log.info(logMessage, line);
	return idpRefusedMessage(detail.provider);
}
