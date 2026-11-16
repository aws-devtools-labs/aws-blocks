// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Re-checking an existing channel subscription (internal).
 *
 * A subscription is authorized once, when the client subscribes with a channel
 * token. The deployed handler (index.aws.ts) and the local WebSocket server
 * (ws-server.ts) both keep what they need of that token with the subscription
 * and call {@link checkSubscriptionAuth} on every client ping, so a subscription
 * ends when its token expires, when the principal no longer matches the
 * connection's, or when access for the principal has been revoked. Sharing the
 * check keeps the two layers from drifting apart.
 */

/** What is kept of a channel token while its subscription is live. */
export interface SubscriptionAuth {
	/** Token expiry, unix seconds. */
	tokenExp: number;
	/** Token issue time, unix seconds. */
	tokenIat: number;
	/** The principal the token is bound to, if any. */
	principal: string | undefined;
}

/** Why a live subscription no longer passes {@link checkSubscriptionAuth}. */
export type SubscriptionAuthFailure = 'token_expired' | 'principal_mismatch' | 'access_revoked';

/**
 * Check a live subscription. Returns why it must end, or `null` while it may continue.
 *
 * @param sub - What was kept of the channel token at subscribe time.
 * @param connectionPrincipal - The principal of the connection's connect token.
 * @param revokedAt - When access for the principal was last revoked (unix seconds), if ever.
 *   Tokens minted at or before that second no longer authorize anything.
 * @param now - The current time, unix seconds.
 */
export function checkSubscriptionAuth(
	sub: SubscriptionAuth,
	connectionPrincipal: string | undefined,
	revokedAt: number | undefined,
	now: number,
): SubscriptionAuthFailure | null {
	if (sub.tokenExp < now) return 'token_expired';
	if (sub.principal !== connectionPrincipal) return 'principal_mismatch';
	if (revokedAt !== undefined && sub.tokenIat <= revokedAt) return 'access_revoked';
	return null;
}

/** The longest a token can stay valid (connect tokens, 2 hours), plus slack: how long a revocation record must be kept. */
export const REVOCATION_RETENTION_SECONDS = 7200 + 300;

/** Message sent to a client whose subscription ended, per failure. */
export function subscriptionEndedMessage(failure: SubscriptionAuthFailure): string {
	switch (failure) {
		case 'token_expired': return 'Unauthorized: token expired';
		case 'principal_mismatch': return 'Unauthorized: token does not match the connection';
		case 'access_revoked': return 'Unauthorized: access revoked';
	}
}
