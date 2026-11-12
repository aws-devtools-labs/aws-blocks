// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { type NextRequest, NextResponse } from 'next/server';
import { API_VERSION, type ApiError, type DataMode, type DataPageResponse } from '@/contract/v1';
import { isAuthorized } from '@/server/auth';
import { getDataProvider } from '@/server/provider-registry';

const MODES: DataMode[] = ['local', 'cloud'];

function isDataMode(value: string): value is DataMode {
	return (MODES as string[]).includes(value);
}

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ fullId: string }> },
): Promise<NextResponse<DataPageResponse | ApiError>> {
	if (!isAuthorized(request.headers.get('authorization'))) {
		return NextResponse.json(
			{
				apiVersion: API_VERSION,
				error: { code: 'UNAUTHORIZED' as const, message: 'Missing or invalid session token' },
			},
			{ status: 401 },
		);
	}
	const q = request.nextUrl.searchParams;
	const mode = q.get('mode') ?? 'local';
	// Rejected, never coerced. A typo'd mode falling back to local would serve
	// local records to someone who believes they are looking at production —
	// they would read, trust, and act on the wrong data with no signal at all.
	if (!isDataMode(mode)) {
		return NextResponse.json(
			{
				apiVersion: API_VERSION,
				error: {
					code: 'BAD_REQUEST' as const,
					message: `Unknown mode "${mode}" — expected one of: ${MODES.join(', ')}.`,
				},
			},
			{ status: 400 },
		);
	}
	// fullId arrives as a path segment, so it is percent-encoded in the URL.
	const { fullId } = await params;
	const limitRaw = q.get('limit');
	const parsedLimit = limitRaw ? Number(limitRaw) : Number.NaN;
	const result = await getDataProvider().readData({
		stage: q.get('stage') ?? 'sandbox',
		mode,
		blockFullId: decodeURIComponent(fullId),
		store: q.get('store') ?? undefined,
		cursor: q.get('cursor') ?? undefined,
		limit: Number.isNaN(parsedLimit) ? undefined : parsedLimit,
	});
	// A dataErrorCode inside a 200 body is correct for a store-level problem:
	// the request succeeded, and the answer is that the store cannot be read.
	// Non-200 is reserved for auth and malformed requests.
	return NextResponse.json({ apiVersion: API_VERSION, ...result });
}
