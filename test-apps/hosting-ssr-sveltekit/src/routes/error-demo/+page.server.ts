// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Throws a real 500 via SvelteKit's error() helper. Renders +error.svelte with
// a 500 status — the e2e suite asserts the real status and no leaked stack.
export const load: PageServerLoad = async () => {
  error(500, 'Intentional error for the error-boundary demo');
};
