// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The browser data client.
 *
 * Importable from Client Components: no database driver, no connection string, no API
 * key. Note the absence of `server-only` here — that is the point. This module only
 * knows how to describe a query and where to post it.
 */

import { createRemoteDataClient } from '@aws-blocks/bb-data/data-api/client';
import type { TableMeta } from './schema/database.meta';

/**
 * In this POC the caller is identified by a dev header; a real app relies on the
 * session cookie the browser already sends, and passes no identity here at all.
 */
export function devUserHeader(userId: string): Record<string, string> {
	return { 'x-blocks-dev-user': userId };
}

export const data = createRemoteDataClient<TableMeta>(async (query) => {
	const response = await fetch('/api/data', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...devUserHeader(currentDevUser) },
		body: JSON.stringify(query),
	});

	if (!response.ok) {
		const body = (await response.json()) as { error?: string; message?: string };
		// Preserve the server's error name so `isBlocksError` works on this side too.
		const error = new Error(body.message ?? response.statusText);
		if (body.error) error.name = body.error;
		throw error;
	}

	return response.json();
});

/** Dev-only: which user the browser claims to be. Replaced by a session in a real app. */
let currentDevUser = 'demo';

export function setDevUser(userId: string): void {
	currentDevUser = userId;
}
