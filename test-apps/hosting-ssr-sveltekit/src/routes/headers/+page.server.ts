// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PageServerLoad } from './$types';

// Set a custom response header + an s-maxage Cache-Control so the e2e suite can
// assert both survive the CloudFront edge (per-response headers and origin
// cache honoring).
export const load: PageServerLoad = async ({ setHeaders }) => {
  setHeaders({
    'x-stress-test': 'on',
    'cache-control': 's-maxage=120, stale-while-revalidate=60',
  });
  return { at: new Date().toISOString() };
};
