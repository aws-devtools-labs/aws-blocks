// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { MARKER, dbRoundTrip, roundTrip } from 'nextjs-resolution-aws-blocks';
import { ClientProbe } from './client-probe';

export const dynamic = 'force-dynamic';

async function attempt(fn: () => Promise<unknown>) {
	try {
		return JSON.stringify(await fn());
	} catch (e) {
		return `THREW: ${(e as Error).message}`;
	}
}

export default async function Home() {
	// Server Component: resolves `react-server`, so these are real blocks in process.
	return (
		<main>
			<p id="rsc">rsc={MARKER}</p>
			<p id="kv">kv={await attempt(roundTrip)}</p>
			<p id="db">db={await attempt(dbRoundTrip)}</p>
			<ClientProbe />
		</main>
	);
}
