// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * How a federated provider is named to users: the default `signIn:<id>` button
 * label ("Sign in with Google") and the local "unavailable" hint ("Google
 * sign-in works after deploy …") share it.
 *
 * @internal
 */

/** Brand-cased provider names for default labels. */
const KNOWN_PROVIDER_NAMES: Record<string, string> = {
	google: 'Google',
	apple: 'Apple',
	facebook: 'Facebook',
	amazon: 'Amazon',
	github: 'GitHub',
	okta: 'Okta',
	auth0: 'Auth0',
};

/** The provider's display name: its brand casing when known, else the id, capitalized. */
export function providerDisplayName(id: string): string {
	return KNOWN_PROVIDER_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}
