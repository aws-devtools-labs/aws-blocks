// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DEPLOY_MARKER } from '@/deploy-marker';

export const dynamic = 'force-dynamic';

// Second-deploy check (scripts/ci/web-function-redeploy.ts): returns the marker
// baked into the deployed server code.
export async function GET() {
  return new Response(DEPLOY_MARKER, { headers: { 'cache-control': 'no-store' } });
}
