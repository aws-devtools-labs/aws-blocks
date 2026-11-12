// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { GuidedEmpty } from '@/components/guided-empty';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiRequestError } from '@/lib/api-client';

/**
 * The card shown when a request to the dashboard's own API did not complete.
 *
 * This exists because four pages had no error branch at all. `apiGet` THROWS on
 * a non-2xx response, so those pages saw `isLoading: false` and an empty list
 * and stated, affirmatively, that there was nothing there — "No deployments
 * recorded yet" for a request that had actually failed, and on the Logs page,
 * pressing Search produced no result, no error and no sign the click had done
 * anything at all.
 *
 * Conflating "empty", "failed" and "never attempted" is the one dishonesty this
 * codebase's design record cares most about; it is why the server responses carry
 * a source/error/code triple and why the doctor models a stack probe three ways.
 * The client half was missing, so the same three states collapsed into one on
 * screen no matter how carefully the server distinguished them.
 */
export function RequestError({ error, what }: { error: unknown; what: string }) {
	if (!error) return null;

	// A 401 has one overwhelmingly likely cause — the token is missing or stale
	// because the page was opened without the CLI's URL fragment — and one fix,
	// so it gets the guided screen.
	//
	// Every OTHER failure deliberately does not. There is no action to offer for
	// an unknown failure beyond retrying, and manufacturing one would mean
	// guessing at a cause, which is the single thing this component was written
	// not to do.
	const status = error instanceof ApiRequestError ? error.status : undefined;
	const detail = status === undefined ? String(error) : `HTTP ${status}: ${(error as Error).message}`;

	if (status === 401) return <GuidedEmpty screen={{ kind: 'unauthorized', detail }} alert />;

	return (
		<Card role="alert">
			<CardHeader>
				<CardTitle className="text-base">Could not load {what}</CardTitle>
				<CardDescription>
					The request did not complete, so this is not an empty result — it is an unknown one.{' '}
					<span className="text-fg-dim">({detail})</span>
				</CardDescription>
			</CardHeader>
		</Card>
	);
}
