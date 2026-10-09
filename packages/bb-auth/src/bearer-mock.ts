// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The local layer's {@link PoolBearerVerifier} (`allowBearerAuth`, D6c).
 *
 * The local user pool (`engines/native-mock*.ts`) mints Cognito-shaped tokens
 * that are **unsigned** (`alg: 'none'`, `AuthCognito`'s mock format), so
 * nothing about such a token can be trusted on its own (DESIGN.md, "mock
 * tokens"). This verifier therefore accepts a token only when
 *
 * 1. it has exactly the mock pool's shape for **this** block — `alg: none`,
 *    issuer `https://mock.bb-auth.local/<fullId>`, `client_id`
 *    `mock-client-<fullId>`, `token_use: access`, unexpired; and
 * 2. the local pool **still recognises it** — it is looked up through the
 *    engine's own access-token check (`getUserAttributes`): the user exists
 *    with the token's `sub`, is enabled, and the token was not revoked by a
 *    global sign-out.
 *
 * Mock-only **by construction**: only `index.mock.ts` imports this module. The
 * AWS entry wires `bearer-cognito.ts`, which never accepts an unsigned token.
 *
 * @internal
 */

import { jwtHeaderAlg } from './bearer.js';
import type { EngineHost, NativeEngine, PoolBearerVerifier } from './engines/types.js';
import { decodeJwtPayload } from './sessions.js';

/**
 * See the module documentation.
 *
 * @internal
 */
export class MockPoolBearerVerifier implements PoolBearerVerifier {
	constructor(
		private readonly host: EngineHost,
		private readonly native: NativeEngine,
	) {}

	async verify(accessToken: string): Promise<{ claims: Record<string, unknown>; hostedUi: boolean } | null> {
		const fullId = this.host.scope.fullId;
		const claims = decodeJwtPayload(accessToken);
		if (!claims || accessToken.split('.').length !== 3) return null;
		if (jwtHeaderAlg(accessToken) !== 'none') return null;
		if (claims.iss !== `https://mock.bb-auth.local/${fullId}`) return null;
		if (claims.client_id !== `mock-client-${fullId}` || claims.token_use !== 'access') return null;
		if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null;
		try {
			// The engine's own access-token check: unknown, disabled, expired or
			// revoked → throws.
			await this.native.getUserAttributes(accessToken);
		} catch (e) {
			this.host.log.warn('[bb-auth] bearer access token rejected by the local user pool', {
				error: e instanceof Error ? e.name : typeof e,
			});
			return null;
		}
		return { claims, hostedUi: false };
	}
}
