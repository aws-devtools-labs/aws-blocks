// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { type NextRequest, NextResponse } from 'next/server';
import { API_VERSION, type ApiError, type UnlockResponse } from '@/contract/v1';
import { isAuthorized, isAuthorizedToMutate } from '@/server/auth';
import { guardMutation } from '@/server/http-guards';
import { setUnlocked, unlockState } from '@/server/write-guard';

/**
 * The write-unlock window.
 *
 * This endpoint is the highest-value target on the whole surface: whoever can
 * call it can turn every cloud write on. In the reference console the
 * equivalent route is unauthenticated and reachable cross-site, which is
 * precisely what makes that console's write gate meaningless — an attacker's
 * page unlocks the console and then writes through it, and same-origin policy
 * does not stop either request because neither needs a readable response.
 *
 * Ours sits behind BOTH the session token and the mutation guard, so an
 * unlock cannot be forged by a page the developer merely happens to visit.
 * The GET is a read and takes the token only; the POST is a mutation and takes
 * both.
 */
function unauthorized(): NextResponse<ApiError> {
	return NextResponse.json(
		{
			apiVersion: API_VERSION,
			error: { code: 'UNAUTHORIZED' as const, message: 'Missing or invalid session token' },
		},
		{ status: 401 },
	);
}

export async function GET(request: NextRequest): Promise<NextResponse<UnlockResponse | ApiError>> {
	if (!isAuthorized(request.headers.get('authorization'))) return unauthorized();
	// No mutation guard: this reads the lock state and changes nothing, and a
	// guard here would block a legitimate non-browser client from polling it.
	return NextResponse.json({ apiVersion: API_VERSION, ...unlockState(), scope: 'cloud-writes' as const });
}

export async function POST(request: NextRequest): Promise<NextResponse<UnlockResponse | ApiError>> {
	if (!isAuthorizedToMutate(request.headers.get('authorization'))) return unauthorized();

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

	const unlock = (body as { unlock?: unknown } | null)?.unlock;
	// A non-boolean is a 400, not a truthiness test. `{"unlock":"false"}` is the
	// case that matters: the string "false" is truthy, so a coercing check would
	// read a request that says "lock" as one that says "unlock" — and it would
	// do it on the one endpoint where getting it backwards opens every cloud
	// write. The same applies to a missing field, which must not mean "unlock".
	if (typeof unlock !== 'boolean') {
		return NextResponse.json(
			{
				apiVersion: API_VERSION,
				error: {
					code: 'BAD_REQUEST' as const,
					message: '"unlock" must be a JSON boolean (true or false), not a string or a missing field.',
				},
			},
			{ status: 400 },
		);
	}

	return NextResponse.json({ apiVersion: API_VERSION, ...setUnlocked(unlock), scope: 'cloud-writes' as const });
}
