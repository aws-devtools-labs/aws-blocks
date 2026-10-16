// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { NextResponse } from 'next/server';
import { API_VERSION, type ApiError, type EnvironmentsResponse } from '@/contract/v1';
import { isAuthorized } from '@/server/auth';
import { getDataProvider } from '@/server/provider-registry';

export async function GET(request: Request): Promise<NextResponse<EnvironmentsResponse | ApiError>> {
	if (!isAuthorized(request.headers.get('authorization'))) {
		return NextResponse.json(
			{ apiVersion: API_VERSION, error: { code: 'UNAUTHORIZED' as const, message: 'Missing or invalid session token' } },
			{ status: 401 },
		);
	}
	const result = await getDataProvider().listEnvironments();
	return NextResponse.json({ apiVersion: API_VERSION, ...result });
}
