// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PageServerLoad } from './$types';

// Server load: runs on the SSR Lambda on every request. A fresh renderedAt on
// each reload proves this is dynamic SSR (not a frozen static page).
export const load: PageServerLoad = async () => {
  return {
    renderedAt: new Date().toISOString(),
    region: process.env.AWS_REGION ?? 'local',
  };
};
