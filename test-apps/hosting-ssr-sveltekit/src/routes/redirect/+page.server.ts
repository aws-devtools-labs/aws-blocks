// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Server-side redirect from the SSR Lambda. The e2e suite asserts the 30x and
// that the Location resolves to the /about page (relative to base).
export const load: PageServerLoad = async () => {
  redirect(307, '/about');
};
