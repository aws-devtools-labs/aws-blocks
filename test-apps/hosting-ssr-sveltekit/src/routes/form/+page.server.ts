// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { fail } from '@sveltejs/kit';
import type { Actions } from './$types';

// Form actions require a running server (cannot be prerendered). Echoes the
// submitted name back so the e2e suite can assert the POST round-trip.
export const actions: Actions = {
  default: async ({ request }) => {
    const data = await request.formData();
    const name = String(data.get('name') ?? '').trim();
    if (!name) {
      return fail(400, { error: 'name is required' });
    }
    return { greeting: `Hello, ${name}!`, at: new Date().toISOString() };
  },
};
