// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { NextResponse } from 'next/server';
import { API_VERSION, type ApiError, type RpcMethodsResponse } from '@/contract/v1';
import { isAuthorized } from '@/server/auth';
import { getDataProvider } from '@/server/provider-registry';

/**
 * The app's callable RPC surface, for the playground's method picker.
 *
 * A read of the app's own source, so no mutation guard: unlike POST /api/v1/rpc
 * next door, nothing here can be provoked into changing anything, and a
 * cross-site GET that cannot read its own response accomplishes nothing.
 * `methodsSource: 'unavailable'` travels inside a 200 — the catalogue being
 * unbuildable is an answer the picker renders, not a failure of this request.
 */
export async function GET(request: Request): Promise<NextResponse<RpcMethodsResponse | ApiError>> {
	if (!isAuthorized(request.headers.get('authorization'))) {
		return NextResponse.json(
			{
				apiVersion: API_VERSION,
				error: { code: 'UNAUTHORIZED' as const, message: 'Missing or invalid session token' },
			},
			{ status: 401 },
		);
	}
	const result = await getDataProvider().listRpcMethods();
	return NextResponse.json({ apiVersion: API_VERSION, ...result });
}
