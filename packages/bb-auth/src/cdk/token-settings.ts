// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lifetimes and refresh rotation for the app clients this block creates
 * (`client`, `hosted-ui-client`). Both clients get the same settings.
 *
 * Every one of these is an in-place `UpdateUserPoolClient`: nothing here
 * replaces a client, so no refresh credential stored in `sessions` is
 * invalidated by the change itself. Rotation is the one that changes behaviour
 * for stored sessions: see `SessionOptions.refreshTokenRotation`.
 */

import * as cdk from 'aws-cdk-lib';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type { ResolvedAuthOptions } from '../resolve-options.js';
import { DEFAULT_SESSION_TTL_SECONDS } from '../sessions.js';

const MINUTE = 60;
const DEFAULT_ACCESS_ID_SECONDS = 3600;
/** Cognito's bounds: ID / access 5 minutes to 1 day; refresh 60 minutes to 10 years. */
const ACCESS_ID_RANGE = [5 * MINUTE, 86_400] as const;
const REFRESH_RANGE = [60 * MINUTE, 10 * 365 * 86_400] as const;
/**
 * How long the rotated-out refresh credential still works (Cognito allows 0 to
 * 60 seconds). It lets a request that lost a race with a concurrent refresh
 * retry instead of ending the session; it is short because it is also the
 * window in which a replayed credential is accepted.
 */
const ROTATION_GRACE_SECONDS = 10;

type ClientLifetimeProps = Pick<
	cognito.UserPoolClientProps,
	'accessTokenValidity' | 'idTokenValidity' | 'refreshTokenValidity' | 'refreshTokenRotationGracePeriod'
>;

function check(name: string, value: number, [min, max]: readonly [number, number]): void {
	if (!Number.isInteger(value) || value % MINUTE !== 0 || value < min || value > max) {
		throw new Error(
			`Auth: session.${name} must be a whole number of minutes, in seconds, from ${min} to ${max} (got ${String(value)}).`,
		);
	}
}

/** Whether `session` sets an option that only exists on a client this block creates. */
export function setsClientLifetimes(options: ResolvedAuthOptions): boolean {
	const s = options.session;
	return (
		s?.accessTokenValiditySeconds !== undefined ||
		s?.idTokenValiditySeconds !== undefined ||
		s?.refreshTokenValiditySeconds !== undefined ||
		s?.refreshTokenRotation !== undefined
	);
}

/** The `UserPoolClient` props for these settings. Throws at synth on a value Cognito would reject. */
export function clientLifetimes(options: ResolvedAuthOptions): ClientLifetimeProps {
	const s = options.session;
	const access = s?.accessTokenValiditySeconds ?? DEFAULT_ACCESS_ID_SECONDS;
	const id = s?.idTokenValiditySeconds ?? DEFAULT_ACCESS_ID_SECONDS;
	// Default: the session lifetime, so the refresh credential never ends a session sooner than `ttlSeconds` says.
	if (s?.ttlSeconds !== undefined && typeof s.ttlSeconds !== 'number') {
		// Shape-only option validation lets an untyped caller pass a string.
		throw new Error(`Auth: session.ttlSeconds must be a number of seconds (got ${JSON.stringify(s.ttlSeconds)}).`);
	}
	const ttl = s?.ttlSeconds !== undefined && s.ttlSeconds > 0 ? s.ttlSeconds : DEFAULT_SESSION_TTL_SECONDS;
	const refresh =
		s?.refreshTokenValiditySeconds ??
		Math.max(REFRESH_RANGE[0], Math.min(REFRESH_RANGE[1], Math.ceil(ttl / MINUTE) * MINUTE));
	check('accessTokenValiditySeconds', access, ACCESS_ID_RANGE);
	check('idTokenValiditySeconds', id, ACCESS_ID_RANGE);
	check('refreshTokenValiditySeconds', refresh, REFRESH_RANGE);
	if (access > refresh || id > refresh) {
		throw new Error(
			'Auth: session.accessTokenValiditySeconds and session.idTokenValiditySeconds cannot exceed session.refreshTokenValiditySeconds.',
		);
	}
	return {
		accessTokenValidity: cdk.Duration.seconds(access),
		idTokenValidity: cdk.Duration.seconds(id),
		refreshTokenValidity: cdk.Duration.seconds(refresh),
		refreshTokenRotationGracePeriod:
			s?.refreshTokenRotation === false ? undefined : cdk.Duration.seconds(ROTATION_GRACE_SECONDS),
	};
}
