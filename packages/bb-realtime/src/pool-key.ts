// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Client connection pool keys (internal). No Node-only imports: both client
 * middlewares, which also run in the browser, share this.
 */

/**
 * The principal a connect token names, read from its payload without checking
 * the signature: it only picks which pooled socket a handle uses, and the server
 * decides what the token is worth. `undefined` for a token with no principal
 * (or one that can't be read).
 */
export function principalOfToken(token: string): string | undefined {
	try {
		// Browser-safe decode (this module also runs in the browser, where `Buffer` is absent).
		const base64 = (token.split('.')[0] ?? '').replace(/-/g, '+').replace(/_/g, '/');
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		const sub: unknown = JSON.parse(new TextDecoder().decode(bytes)).sub;
		return typeof sub === 'string' ? sub : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Pool key: one socket per endpoint and principal. The server ties a connection
 * to the principal of its connect token, so handles for different users (or a
 * user-bound handle and an unbound one) can't share a socket.
 */
export function poolKey(wsUrl: string, connectToken: string): string {
	const principal = principalOfToken(connectToken);
	return principal === undefined ? wsUrl : `${wsUrl}\u0000${principal}`;
}
