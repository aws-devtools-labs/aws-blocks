// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Edge-cacheable SSR route that also sets a cookie, used to assert over the
 * wire that a response carrying `Set-Cookie` is sent as
 * `Cache-Control: private, no-store` whatever the origin asked for
 * (CloudFront would otherwise store the `Set-Cookie` with the object and
 * replay it on every hit).
 */
export async function GET() {
  const res = new NextResponse('cache-isolation set-cookie', {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, s-maxage=300, max-age=0',
    },
  });
  res.cookies.set('bb_visit', crypto.randomUUID(), { path: '/', httpOnly: true });
  return res;
}
