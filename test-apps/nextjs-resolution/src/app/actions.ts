// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
'use server';

import { MARKER, dbRoundTrip } from 'nextjs-resolution-aws-blocks';

// Server Actions are the client→server boundary in the Next-native model, so the
// condition this module resolves under is load-bearing.
export async function probeAction() {
	let db: unknown;
	try {
		db = await dbRoundTrip();
	} catch (e) {
		db = `THREW: ${(e as Error).message}`;
	}
	return { context: 'server-action', marker: MARKER, db };
}
