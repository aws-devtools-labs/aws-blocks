// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiRequestError } from '@/lib/api-client';

export function Providers({ children }: { children: React.ReactNode }) {
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						refetchOnWindowFocus: true,
						/**
						 * Retry a server-side or network failure once; never retry a 4xx.
						 *
						 * A 401 from a missing or stale session token is not going to
						 * succeed on a second attempt, and retrying it keeps every page on
						 * "Loading…" for the length of the backoff — which reads as a slow
						 * dashboard rather than an auth problem, and delays the error card
						 * that explains the actual fix. The same applies to a 400 or a 404:
						 * the request was wrong, not unlucky.
						 */
						retry: (failureCount, error) => {
							const status = error instanceof ApiRequestError ? error.status : undefined;
							if (status !== undefined && status >= 400 && status < 500) return false;
							return failureCount < 1;
						},
					},
				},
			}),
	);
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
