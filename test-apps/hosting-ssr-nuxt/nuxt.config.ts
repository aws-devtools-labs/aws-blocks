// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// HOSTING_NITRO_STREAMING=off leaves `awsLambda.streaming` unset (Nitro's
// default), so the `aws-lambda` preset builds a buffered handler.
const streaming = process.env.HOSTING_NITRO_STREAMING !== 'off';

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },

  nitro: {
    ...(streaming && { awsLambda: { streaming: true } }),
    experimental: { asyncContext: true },
  },

  routeRules: {
    '/about': { prerender: true },
    '/headers-test': {
      headers: {
        'x-stress-test': 'on',
        'cache-control': 's-maxage=120, stale-while-revalidate=60',
      },
    },
    '/old-page': { redirect: '/about' },
  },
});
