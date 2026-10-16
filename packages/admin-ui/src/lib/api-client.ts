// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Client-side Dashboard API access.
 *
 * The CLI opens the browser at http://127.0.0.1:<port>/#token=<token>. The
 * fragment never reaches the server; we read it once, keep it in memory
 * (sessionStorage survives reloads within the tab), strip it from the URL,
 * and send it as an Authorization header on every /api call.
 */

const STORAGE_KEY = 'blocks-dashboard-token';

export function getSessionToken(): string | undefined {
	if (typeof window === 'undefined') return undefined;
	const fromHash = /[#&]token=([^&]+)/.exec(window.location.hash)?.[1];
	if (fromHash) {
		window.sessionStorage.setItem(STORAGE_KEY, fromHash);
		// Drop the token from the visible URL / browser history.
		window.history.replaceState(null, '', window.location.pathname + window.location.search);
		return fromHash;
	}
	return window.sessionStorage.getItem(STORAGE_KEY) ?? undefined;
}

export class ApiRequestError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'ApiRequestError';
	}
}

export async function apiGet<T>(path: string): Promise<T> {
	const token = getSessionToken();
	const response = await fetch(path, {
		headers: token ? { authorization: `Bearer ${token}` } : {},
	});
	if (!response.ok) {
		throw new ApiRequestError(response.status, `${path} failed with ${response.status}`);
	}
	return (await response.json()) as T;
}
