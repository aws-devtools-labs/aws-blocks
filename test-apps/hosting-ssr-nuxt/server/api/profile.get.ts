// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { api } from 'hosting-ssr-nuxt-aws-blocks';
import { withAuth } from 'aws-cdk-blocks/server';

export default defineEventHandler(async () => {
  try {
    return await withAuth(() => api.getProfile());
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = (err as any)?.status ?? (err as any)?.cause?.status ?? 500;
    throw createError({ statusCode: status, statusMessage: 'unauthorized' });
  }
});
