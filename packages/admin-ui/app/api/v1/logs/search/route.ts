// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { type NextRequest, NextResponse } from 'next/server';
import { API_VERSION, type ApiError, type LogSearchResponse } from '@/contract/v1';
import { isAuthorized } from '@/server/auth';
import { getDataProvider } from '@/server/provider-registry';

export async function GET(request: NextRequest): Promise<NextResponse<LogSearchResponse | ApiError>> {
	if (!isAuthorized(request.headers.get('authorization'))) {
		return NextResponse.json(
			{ apiVersion: API_VERSION, error: { code: 'UNAUTHORIZED' as const, message: 'Missing or invalid session token' } },
			{ status: 401 },
		);
	}
	const q = request.nextUrl.searchParams;
	const limitRaw = q.get('limit');
	const result = await getDataProvider().searchLogs({
		stage: q.get('stage') ?? 'sandbox',
		text: q.get('text') ?? undefined,
		level: q.get('level') ?? undefined,
		logger: q.get('logger') ?? undefined,
		traceId: q.get('traceId') ?? undefined,
		group: q.get('group') ?? undefined,
		start: q.get('start') ?? undefined,
		end: q.get('end') ?? undefined,
		limit: limitRaw ? Number(limitRaw) : undefined,
	});
	return NextResponse.json({ apiVersion: API_VERSION, ...result });
}
