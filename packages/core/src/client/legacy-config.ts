// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The deployed stage a `.blocks-sandbox/config.json` points at, when a deploy
 * from before core 0.8 wrote it, else `null`.
 *
 * Only a dev server writes `config.json` now, always with an `http:` URL of its
 * own: `environment` is `local`, or `sandbox` for the dev server `blocks
 * sandbox` runs. Older deploys wrote their AWS URL there, with `environment`
 * `production` or `sandbox`. So a `production` file, or a `sandbox` file whose
 * `apiUrl` is `https:`, is such a leftover.
 */
export function legacyDeployedStage(config: unknown): 'production' | 'sandbox' | null {
  if (!config || typeof config !== 'object') return null;
  const { environment, apiUrl } = config as { environment?: unknown; apiUrl?: unknown };
  if (environment === 'production') return 'production';
  if (environment === 'sandbox' && typeof apiUrl === 'string' && apiUrl.startsWith('https:')) return 'sandbox';
  return null;
}
