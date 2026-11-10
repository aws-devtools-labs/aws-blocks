// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';

// Read the caller's session cookie at request time (dynamic SSR), so the
// rendered body is personalized per user.
export const dynamic = 'force-dynamic';

/**
 * Per-session, edge-cacheable SSR route used to assert per-session cache
 * keying over the wire.
 *
 * The response body echoes the `bb_session` cookie and sets
 * `Cache-Control: public, s-maxage=300`, so CloudFront caches it. Because the
 * app's `cdn.cacheKeyCookies` includes `bb_session`, each distinct session
 * value keys a separate cache entry, so the e2e can assert responses are
 * keyed per session.
 *
 * A request carrying a cookie outside the cache key (or `Authorization`) gets
 * the same response as `Cache-Control: private, no-store` from the hosting
 * SSR cache guard, so it is never stored under the shared key.
 */
export async function GET(req: NextRequest) {
  const session = req.cookies.get('bb_session')?.value ?? 'anonymous';
  return new NextResponse(`cache-isolation user=${session}`, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // Make the response edge-cacheable so the CDN cache key is exercised.
      'cache-control': 'public, s-maxage=300, max-age=0',
    },
  });
}
