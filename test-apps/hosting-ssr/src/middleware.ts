// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { NextResponse, type NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith('/middleware-protected')) {
    const session = req.cookies.get('mw-session')?.value;
    if (!session) {
      const url = req.nextUrl.clone();
      url.pathname = '/middleware-login';
      url.searchParams.set('next', pathname);
      return NextResponse.redirect(url);
    }
  }
  const res = NextResponse.next();
  res.headers.set('x-middleware-saw', '1');
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.blocks-sandbox).*)'],
};
