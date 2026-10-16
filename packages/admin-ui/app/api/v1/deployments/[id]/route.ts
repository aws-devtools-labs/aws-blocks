// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { type NextRequest, NextResponse } from 'next/server';
import { API_VERSION, type ApiError, type DeploymentDetailResponse } from '@/contract/v1';
import { isAuthorized } from '@/server/auth';
import { getDataProvider } from '@/server/provider-registry';

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<DeploymentDetailResponse | ApiError>> {
	if (!isAuthorized(request.headers.get('authorization'))) {
		return NextResponse.json(
			{ apiVersion: API_VERSION, error: { code: 'UNAUTHORIZED' as const, message: 'Missing or invalid session token' } },
			{ status: 401 },
		);
	}
	const { id } = await params;
	const detail = await getDataProvider().getDeployment(id);
	if (!detail) {
		return NextResponse.json(
			{ apiVersion: API_VERSION, error: { code: 'NOT_FOUND' as const, message: `No deployment with id ${id}` } },
			{ status: 404 },
		);
	}
	return NextResponse.json({ apiVersion: API_VERSION, ...detail });
}
