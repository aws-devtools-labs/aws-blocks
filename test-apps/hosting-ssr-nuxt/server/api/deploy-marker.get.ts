// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DEPLOY_MARKER } from '../deploy-marker';

// Second-deploy check (scripts/ci/web-function-redeploy.ts): returns the marker
// baked into the deployed server code.
export default defineEventHandler((event) => {
  setResponseHeader(event, 'cache-control', 'no-store');
  return DEPLOY_MARKER;
});
