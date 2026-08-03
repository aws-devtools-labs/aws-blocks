// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { MARKER, dbRoundTrip } from 'nextjs-resolution-aws-blocks';

export const dynamic = 'force-dynamic';

export async function GET() {
	let db: unknown;
	try {
		db = await dbRoundTrip();
	} catch (e) {
		db = `THREW: ${(e as Error).message}`;
	}
	return Response.json({ context: 'route-handler', marker: MARKER, db });
}
