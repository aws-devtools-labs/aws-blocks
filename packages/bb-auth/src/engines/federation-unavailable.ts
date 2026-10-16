// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A {@link FederationEngine} for a provider this runtime cannot serve, whose
 * every sign-in answers with an **actionable** `ApiError` — never a 404 and
 * never a confusing OIDC failure. The provider's routes are still mounted, so
 * the `signIn:<id>` button reaches this message.
 *
 * Used for:
 * - a hosted-UI provider (social, SAML, `federateVia: 'cognito'`) in local
 *   dev: Cognito's managed login does not exist offline (in Lambda the
 *   hosted-UI engine, `federation-hosted-ui.ts`, serves it);
 * - a `stubIdp()` provider in Lambda: the stub runs only on the dev server
 *   (unless the provider sets `unsafeAllowDeployed`, which serves it deployed).
 *
 * Sessions such a provider could never have issued are treated as signed out
 * on refresh, and sign-out is local only.
 *
 * @internal
 */

import { ApiError } from '@aws-blocks/core';
import { AuthErrors } from '../errors.js';
import type { FederationEngine, ResolvedProvider } from './types.js';

/** Why the provider is unavailable here. */
export type UnavailableReason = 'hosted-ui-local' | 'stub-deployed';

/** The client-facing message for `reason` (exported for tests). */
export function unavailableMessage(provider: ResolvedProvider, reason: UnavailableReason): string {
	const what =
		provider.family === 'social'
			? 'a social provider, federated through Cognito managed login'
			: provider.family === 'saml'
				? 'a SAML provider, federated through Cognito managed login'
				: "an OIDC provider with federateVia: 'cognito'";
	switch (reason) {
		case 'hosted-ui-local':
			return (
				`Sign-in provider '${provider.id}' is ${what}, which is unavailable locally (npm run dev): managed login ` +
				'needs a deployed Cognito user pool. Use a direct provider (an oidcProviders entry without ' +
				"federateVia: 'cognito') or the stub IdP (stubIdp()) for local sign-in, or deploy a sandbox to test this provider."
			);
		case 'stub-deployed':
			return (
				`Sign-in provider '${provider.id}' is a stub IdP (stubIdp()), which runs only in local development ` +
				'(npm run dev). Replace it with the real provider before deploying (a disposable test stack can opt in ' +
				'with stubIdp({ unsafeAllowDeployed: true }), which lets anyone sign in as the stub users).'
			);
	}
}

/** @internal */
export function unavailableFederationEngine(provider: ResolvedProvider, reason: UnavailableReason): FederationEngine {
	const fail = (): Promise<never> =>
		Promise.reject(
			new ApiError(unavailableMessage(provider, reason), 501, { name: AuthErrors.ProviderMisconfigured }),
		);
	return {
		buildSignInUrl: fail,
		completeSignIn: fail,
		exchangeCode: fail,
		authorizeParams: fail,
		refreshBearer: fail,
		refresh: async () => null,
		signOut: async () => ({}),
	};
}
