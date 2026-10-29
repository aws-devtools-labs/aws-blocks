// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The AWS layer's {@link PoolBearerVerifier} (`allowBearerAuth`, D6c): accepts
 * a Cognito **access token** issued by this block's user pool, verified with
 * `aws-jwt-verify` — RS256 signature against the pool's JWKS, issuer = the
 * pool, `token_use: access`, `client_id` = the native app client, the
 * hosted-UI app client (a Cognito-federated sign-in), or one of the extra
 * clients `allowBearerAuth.clientIds` / `Auth.fromExisting(…, clientId)` name
 * (`bearerClientIds`), and expiry (30 s of clock tolerance, as `AuthOIDC`).
 * Unsigned (`alg: none`) and symmetric (HMAC) tokens never verify here.
 *
 * Imported only by the `aws-runtime` entry. Identifiers are resolved at call
 * time: the pool and native client ids from the registry the Cognito engine
 * fills (`getSdkIdentifiers`), the hosted-UI client id from its config key
 * (`federationConfigKeys`, set only when hosted-UI federation is enabled), the
 * extra clients from their config key (`bearerClientIdsConfigKey`: resolved at
 * deploy time, so ids given as CDK tokens work) plus any literal ids in the
 * options. An option value that isn't a literal client id (a CDK token, which
 * cannot exist in the Lambda, or an empty value) is ignored, logged once.
 *
 * @internal
 */

import { getSdkIdentifiers } from '@aws-blocks/core';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { jwtHeaderAlg } from './bearer.js';
import {
	bearerClientIds,
	bearerClientIdsConfigKey,
	federationConfigKeys,
	isLiteralCognitoClientId,
} from './cdk/contract.js';
import type { BearerClientKind, EngineHost, PoolBearerVerifier } from './engines/types.js';
import { decodeJwtPayload } from './sessions.js';

type AccessTokenVerifier = ReturnType<typeof CognitoJwtVerifier.create>;

/** The region a pool id names (`us-east-1_abc` → `us-east-1`), or `''`. */
function regionOfPool(userPoolId: string): string {
	const idx = userPoolId.indexOf('_');
	return idx > 0 ? userPoolId.slice(0, idx) : '';
}

/**
 * See the module documentation.
 *
 * @internal
 */
export class CognitoAccessTokenVerifier implements PoolBearerVerifier {
	private verifierCache?: { key: string; verifier: AccessTokenVerifier };
	private warnedNonLiteral = false;

	constructor(private readonly host: EngineHost) {}

	async verify(accessToken: string): Promise<{ claims: Record<string, unknown>; client: BearerClientKind } | null> {
		try {
			const ids = this.ids();
			if (!ids) return null;
			const claims = decodeJwtPayload(accessToken);
			if (!claims || accessToken.split('.').length !== 3) return null;
			// Cheap pre-checks (no JWKS fetch for a token that cannot be ours).
			// Cognito signs with RS256 only; `aws-jwt-verify` would reject
			// `none` / HMAC anyway — this makes the rule explicit.
			if (jwtHeaderAlg(accessToken) !== 'RS256') return null;
			if (claims.iss !== ids.issuer) return null;
			const payload = await this.verifier.verify(accessToken);
			const verified: Record<string, unknown> = { ...payload };
			// The hosted-UI client signs in only Cognito-federated users (no
			// `COGNITO` provider); an extra client may sign in anyone.
			const client: BearerClientKind =
				verified.client_id === ids.nativeClientId
					? 'native'
					: verified.client_id === ids.hostedUiClientId
						? 'hostedUi'
						: 'extra';
			return { claims: verified, client };
		} catch (e) {
			this.host.log.warn('[bb-auth] bearer access token rejected', {
				error: e instanceof Error ? e.name : typeof e,
			});
			return null;
		}
	}

	/** The pool's identifiers, resolved now; `null` (logged) when the pool is not configured. */
	private ids(): {
		userPoolId: string;
		issuer: string;
		clientIds: string[];
		nativeClientId: string;
		hostedUiClientId: string;
	} | null {
		const { userPoolId, clientId, region } = getSdkIdentifiers(this.host.scope);
		if (!userPoolId || !clientId) {
			this.host.log.error('[bb-auth] bearer token received but no user pool is configured for this Auth', {
				fullId: this.host.scope.fullId,
			});
			return null;
		}
		const hostedUiClientId = process.env[federationConfigKeys(this.host.scope.fullId).HOSTED_UI_CLIENT_ID] ?? '';
		const resolvedRegion = region || regionOfPool(userPoolId);
		const clientIds = [clientId];
		for (const id of [hostedUiClientId, ...this.extraClientIds()]) {
			if (id && !clientIds.includes(id)) clientIds.push(id);
		}
		return {
			userPoolId,
			issuer: `https://cognito-idp.${resolvedRegion}.amazonaws.com/${userPoolId}`,
			clientIds,
			nativeClientId: clientId,
			hostedUiClientId,
		};
	}

	/**
	 * The extra bearer client ids: the deploy-time-resolved list from config,
	 * then the literal ids in the options (the same list, when they are
	 * literals; the only source in a process with no config, such as a test).
	 */
	private extraClientIds(): string[] {
		const configured = (process.env[bearerClientIdsConfigKey(this.host.scope.fullId)] ?? '')
			.split(',')
			.map((id) => id.trim())
			.filter(isLiteralCognitoClientId);
		const fromOptions: string[] = [];
		for (const id of bearerClientIds(this.host.options)) {
			if (isLiteralCognitoClientId(id)) fromOptions.push(id);
			else if (!this.warnedNonLiteral) {
				this.warnedNonLiteral = true;
				this.host.log.warn(
					'[bb-auth] an allowBearerAuth client id in the options is not a literal app-client id here (a CDK token resolves only at deploy time); using the deployed config for it',
					{ fullId: this.host.scope.fullId },
				);
			}
		}
		return [...configured, ...fromOptions];
	}

	/**
	 * The access-token verifier for the current pool and clients, created on
	 * first use and recreated if they change. Call only after {@link ids}
	 * returned identifiers.
	 */
	private get verifier(): AccessTokenVerifier {
		const ids = this.ids();
		if (!ids) throw new Error('no user pool is configured');
		const key = `${ids.userPoolId}\n${ids.clientIds.join('\n')}`;
		if (this.verifierCache?.key !== key) {
			this.verifierCache = {
				key,
				verifier: CognitoJwtVerifier.create({
					userPoolId: ids.userPoolId,
					tokenUse: 'access',
					clientId: ids.clientIds,
					graceSeconds: 30,
				}),
			};
		}
		return this.verifierCache.verifier;
	}
}
