// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { type NextRequest, NextResponse } from 'next/server';
import { API_VERSION, type ApiError, type CostResponse } from '@/contract/v1';
import { isAuthorized } from '@/server/auth';
import { getDataProvider } from '@/server/provider-registry';

export async function GET(request: NextRequest): Promise<NextResponse<CostResponse | ApiError>> {
	if (!isAuthorized(request.headers.get('authorization'))) {
		return NextResponse.json(
			{ apiVersion: API_VERSION, error: { code: 'UNAUTHORIZED' as const, message: 'Missing or invalid session token' } },
			{ status: 401 },
		);
	}
	const stage = request.nextUrl.searchParams.get('stage') ?? 'sandbox';
	const result = await getDataProvider().getCost(stage);
	return NextResponse.json({ apiVersion: API_VERSION, ...result });
}
