// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';

/**
 * The API URL the suite targets for BLOCKS_TEST_ENV: in `sandbox` and
 * `production` mode, the one the deploy of that stage recorded in
 * `.blocks-sandbox/config.<stage>.json`; locally, the dev server's
 * `.blocks-sandbox/config.json`. A deploy never writes `config.json`, so a local
 * run never reaches a deployed stack.
 */
export function testApiUrl(): string {
  const env = process.env.BLOCKS_TEST_ENV || 'local';
  const file = env === 'sandbox' || env === 'production' ? `config.${env}.json` : 'config.json';
  const config = JSON.parse(readFileSync(`.blocks-sandbox/${file}`, 'utf-8'));
  return config.apiUrl;
}

/** {@link testApiUrl} without its `/aws-blocks/api` path: the origin of the app's routes. */
export function testBaseUrl(): string {
  return testApiUrl().replace(/\/aws-blocks\/api$/, '');
}
