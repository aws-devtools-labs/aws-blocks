// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RequestHandler } from './$types';
import { DEPLOY_MARKER } from '$lib/deploy-marker';

// Second-deploy check (scripts/ci/web-function-redeploy.ts): returns the marker
// baked into the deployed server code.
export const GET: RequestHandler = () =>
  new Response(DEPLOY_MARKER, { headers: { 'cache-control': 'no-store' } });
