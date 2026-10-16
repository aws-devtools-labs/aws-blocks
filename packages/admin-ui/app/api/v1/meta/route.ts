// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { NextResponse } from 'next/server';
import { API_VERSION, type ApiError, type MetaResponse } from '@/contract/v1';
import { isAuthorized } from '@/server/auth';
import { getDataProvider } from '@/server/provider-registry';
import packageJson from '../../../../package.json';

export async function GET(request: Request): Promise<NextResponse<MetaResponse | ApiError>> {
	if (!isAuthorized(request.headers.get('authorization'))) {
		return NextResponse.json(
			{ apiVersion: API_VERSION, error: { code: 'UNAUTHORIZED' as const, message: 'Missing or invalid session token' } },
			{ status: 401 },
		);
	}
	const meta = await getDataProvider().getProjectMeta();
	return NextResponse.json({
		apiVersion: API_VERSION,
		adminUiVersion: packageJson.version,
		projectName: meta.projectName,
		projectRoot: meta.projectRoot,
		stages: meta.stages,
	});
}
