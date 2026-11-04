// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { type NextRequest, NextResponse } from 'next/server';
import { API_VERSION, type ApiError, type UsageResponse } from '@/contract/v1';
import { isAuthorized } from '@/server/auth';
import { getDataProvider } from '@/server/provider-registry';
import { isConfirmed, parseRangeMinutes } from '@/server/usage-request';

/**
 * GET /api/v1/usage?stage=&rangeMinutes=&confirm=
 *
 * THE CONSENT DECISION IS MADE HERE, not in the provider, for the reason the
 * write-unlock gate is: only a route sees a request, so only a route can say
 * whether this caller consented. A provider that decided for itself could be
 * reached by a CLI command or a script and would have to invent an answer.
 * The provider is handed the decision and owns its consequence: with
 * `confirmed: false` it makes no billable call.
 *
 * Unlike the write unlock, consent is NOT session state. It is a parameter of
 * the request, so it cannot be inherited by a later call and cannot outlive
 * the estimate the user actually saw. A reload is gated again, which is
 * correct: it is another priced request.
 */
export async function GET(request: NextRequest): Promise<NextResponse<UsageResponse | ApiError>> {
	if (!isAuthorized(request.headers.get('authorization'))) {
		return NextResponse.json(
			{
				apiVersion: API_VERSION,
				error: { code: 'UNAUTHORIZED' as const, message: 'Missing or invalid session token' },
			},
			{ status: 401 },
		);
	}
	const params = request.nextUrl.searchParams;
	const result = await getDataProvider().getUsage({
		stage: params.get('stage') ?? 'sandbox',
		rangeMinutes: parseRangeMinutes(params.get('rangeMinutes')),
		confirmed: isConfirmed(params.get('confirm')),
	});
	return NextResponse.json({ apiVersion: API_VERSION, ...result });
}
