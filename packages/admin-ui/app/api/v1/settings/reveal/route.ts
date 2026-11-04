// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { type NextRequest, NextResponse } from 'next/server';
import { API_VERSION, type ApiError, type DataMode, type SettingRevealResponse } from '@/contract/v1';
import { isAuthorizedToMutate } from '@/server/auth';
import { guardMutation } from '@/server/http-guards';
import { getDataProvider } from '@/server/provider-registry';

/**
 * Reveal ONE setting's value, decrypted.
 *
 * ## Why a POST for something that only reads
 *
 * The same reasoning the RPC route sets out, in the other direction. A route
 * named "reveal" reads as a read, and it is one, but its consequence is a
 * credential leaving this host. So it carries the full mutation hardening
 * (Content-Type, Origin, Sec-Fetch-Site) rather than the read gate, because
 * an attacker's page needs no more than a form post to trigger a GET, and a
 * guard that only runs on writes would leave the single highest-value read on
 * the surface unprotected.
 *
 * The one thing it will not accept is a parameter path. The caller names a
 * declared setting by `fullId` and the provider resolves it, so the reachable
 * set is exactly what the app declares rather than every SSM parameter the
 * developer's credentials can reach.
 */
export async function POST(
	request: NextRequest,
): Promise<NextResponse<SettingRevealResponse | ApiError>> {
	if (!isAuthorizedToMutate(request.headers.get('authorization'))) {
		return NextResponse.json(
			{
				apiVersion: API_VERSION,
				error: { code: 'UNAUTHORIZED' as const, message: 'Missing or invalid session token' },
			},
			{ status: 401 },
		);
	}

	const guard = guardMutation(request);
	if (!guard.ok) {
		return NextResponse.json(
			{ apiVersion: API_VERSION, error: { code: 'BAD_REQUEST' as const, message: guard.message } },
			{ status: guard.status },
		);
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json(
			{
				apiVersion: API_VERSION,
				error: { code: 'BAD_REQUEST' as const, message: 'Request body must be valid JSON.' },
			},
			{ status: 400 },
		);
	}

	const { fullId, stage, mode } = (body ?? {}) as {
		fullId?: unknown;
		stage?: unknown;
		mode?: unknown;
	};
	if (typeof fullId !== 'string' || fullId.length === 0) {
		return NextResponse.json(
			{
				apiVersion: API_VERSION,
				error: { code: 'BAD_REQUEST' as const, message: '"fullId" must name a declared setting.' },
			},
			{ status: 400 },
		);
	}

	const resolved = await getDataProvider().revealSetting({
		fullId,
		stage: typeof stage === 'string' && stage.length > 0 ? stage : 'sandbox',
		mode: (mode === 'cloud' ? 'cloud' : 'local') as DataMode,
	});
	if (!resolved) {
		// One answer for "no such declaration" and for "the stage does not hold
		// it": both are "there is nothing to show you", and splitting them
		// would let a caller enumerate which ids exist.
		return NextResponse.json(
			{
				apiVersion: API_VERSION,
				error: { code: 'NOT_FOUND' as const, message: 'No value is held for that setting in this stage.' },
			},
			{ status: 404 },
		);
	}
	return NextResponse.json({ apiVersion: API_VERSION, ...resolved });
}
