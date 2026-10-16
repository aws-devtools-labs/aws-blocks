// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { type NextRequest, NextResponse } from 'next/server';
import { API_VERSION, type ApiError, type DataMode, type SettingHistoryResponse } from '@/contract/v1';
import { isAuthorized } from '@/server/auth';
import { getDataProvider } from '@/server/provider-registry';

/**
 * Versions of one setting, newest first, so a rollback names a version instead
 * of retyping a value from memory.
 *
 * A read, and unlike the reveal it carries no secret: a secret's past values
 * are dropped by the provider, because a decrypted history would hand over
 * every value the parameter ever held in a single call.
 */
export async function GET(
	request: NextRequest,
): Promise<NextResponse<SettingHistoryResponse | ApiError>> {
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
	const fullId = params.get('fullId');
	if (!fullId) {
		return NextResponse.json(
			{
				apiVersion: API_VERSION,
				error: { code: 'BAD_REQUEST' as const, message: '"fullId" must name a declared setting.' },
			},
			{ status: 400 },
		);
	}
	const mode: DataMode = params.get('mode') === 'cloud' ? 'cloud' : 'local';
	const result = await getDataProvider().listSettingVersions({
		fullId,
		stage: params.get('stage') ?? 'sandbox',
		mode,
	});
	return NextResponse.json({ apiVersion: API_VERSION, ...result });
}
