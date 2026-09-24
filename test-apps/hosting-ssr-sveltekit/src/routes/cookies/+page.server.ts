// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PageServerLoad } from './$types';

// Reads the sk_visit cookie seeded by hooks.server.ts and sets a page-scoped
// cookie, exercising cookie set/read round-trips through CloudFront -> Lambda.
export const load: PageServerLoad = async ({ cookies }) => {
  const visit = cookies.get('sk_visit') ?? null;
  cookies.set('sk_seen_cookies_page', '1', {
    path: '/',
    httpOnly: false,
    sameSite: 'lax',
    maxAge: 3600,
  });
  return { visit };
};
