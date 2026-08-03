// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import 'server-only';

import { headers } from 'next/headers';
import type { DataApiUser } from '@aws-blocks/bb-data/data-api';

/**
 * NOT AUTHENTICATION. A stand-in so this POC can demonstrate the data API's
 * authorization contract without pulling in a full auth provider.
 *
 * It trusts a request header, which means anyone can claim to be anyone. A real app
 * wires `auth: () => authBlock.requireAuth(context)` instead — an auth block verifies a
 * signed session and cannot be spoofed by a header.
 *
 * What it is genuinely useful for: proving that the data API refuses unauthenticated
 * callers, and that RLS isolates rows by the claims it is given.
 */
const DEV_USER_HEADER = 'x-blocks-dev-user';

/** Refuse to run outside development, so this cannot be deployed by accident. */
function assertNotProduction(): void {
	if (process.env.NODE_ENV === 'production') {
		throw new Error(
			'lib/dev-auth.ts is a development stand-in and must never run in production. ' +
				'Replace it with a real auth block before deploying.',
		);
	}
}

/**
 * Resolve the caller from the dev header.
 *
 * @returns The claimed user, or `null` when the header is absent — which is what makes
 * the data API's `NotAuthenticated` path exercisable.
 */
export async function getDevUser(): Promise<DataApiUser | null> {
	assertNotProduction();

	const userId = (await headers()).get(DEV_USER_HEADER)?.trim();
	if (!userId) return null;

	return {
		userId,
		role: 'authenticated',
		// `sub` is what the RLS policy reads out of request.jwt.claims.
		claims: { sub: userId },
	};
}
