// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Handle } from '@sveltejs/kit';

/**
 * Server hook — proves hooks.server runs on every dynamic request behind
 * CloudFront/Lambda. Sets a header the e2e suite asserts, and seeds a
 * server-set cookie the /cookies page reads back.
 */
export const handle: Handle = async ({ event, resolve }) => {
  // Seed a visit cookie if the client doesn't already have one.
  if (!event.cookies.get('sk_visit')) {
    event.cookies.set('sk_visit', `v-${Date.now()}`, {
      path: '/',
      httpOnly: false,
      sameSite: 'lax',
      maxAge: 3600,
    });
  }

  const response = await resolve(event);
  response.headers.set('x-sk-hook', 'on');
  return response;
};
