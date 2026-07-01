// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, RawRoute, AppSetting, KVStore } from '@aws-blocks/blocks';

const scope = new Scope('telemetry-e2e-test');

new RawRoute(scope, 'health', {
  method: 'GET',
  path: '/health',
  handler: async (context) => {
    context.response.send({ ok: true });
  },
});

new AppSetting(scope, 'test-setting', {
  name: '/telemetry-e2e/api-url',
  value: 'https://example.com',
});

new KVStore(scope, 'cache');

// Custom (non-official) building block for telemetry filtering tests.
// This BB has a bbName NOT in OFFICIAL_BB_NAMES, so it should NOT appear
// in the telemetry payload's product.buildingBlocks array — only counted
// in counters.customBuildingBlocks.
new Scope('custom-analytics-tracker', {
  parent: scope,
  bbName: 'CustomAnalyticsTracker',
  bbVersion: '0.0.1',
});
