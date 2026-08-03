// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { DataApiErrors, createDataApi } from '@aws-blocks/bb-data/data-api';
import { isBlocksError } from '@aws-blocks/blocks';
import { db } from '@/lib/backend';
import { getDevUser } from '@/lib/dev-auth';
import { tableMeta } from '@/lib/schema/database.meta';

export const dynamic = 'force-dynamic';

/**
 * The whole browser data surface: ONE endpoint for every table and query shape.
 *
 * There is no per-query endpoint to write, and no URL or API key for the client to
 * hold — the browser client posts a query description here and the session it already
 * has identifies the caller.
 */
const dataApi = createDataApi({
	db,
	schema: tableMeta,
	// Opt-in. Nothing is reachable from a browser until it is named here.
	tables: ['notes'],
	// Mandatory: there is no anonymous mode to forget to turn off.
	auth: getDevUser,
	maxLimit: 100,
});

/** Map a thrown Blocks error to a status code, without leaking internals. */
function statusFor(error: unknown): number {
	if (isBlocksError(error, DataApiErrors.NotAuthenticated)) return 401;
	if (isBlocksError(error, DataApiErrors.TableNotExposed)) return 403;
	if (isBlocksError(error, DataApiErrors.InvalidQuery)) return 400;
	return 500;
}

export async function POST(request: Request) {
	try {
		const rows = await dataApi.execute(await request.json());
		return Response.json(rows);
	} catch (error) {
		const status = statusFor(error);
		// Only report the message for errors we raised deliberately; anything else could
		// carry database or SDK detail.
		const message = status === 500 ? 'internal error' : (error as Error).message;
		return Response.json({ error: (error as Error).name, message }, { status });
	}
}
