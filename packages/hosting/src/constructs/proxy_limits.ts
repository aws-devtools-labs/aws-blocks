// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The response-size limit of the regional doors' Lambda asset proxies.
 *
 * The ALB and API Gateway doors serve static files through an asset-proxy
 * Lambda that returns the whole file, base64-encoded, in its JSON response.
 * So a file is capped by that path's response limit, after base64's 4/3
 * inflation:
 *
 * - ALB (Lambda target): the response JSON can be at most 1 MB;
 * - API Gateway (Lambda proxy integration): Lambda's synchronous response
 *   limit, 6 MB — below API Gateway's own 10 MB payload limit, so it binds.
 *
 * A larger file fails at the door (the ALB answers 502). Synth lists every
 * build asset over the limit so it can be moved (to the CloudFront or stacked
 * door, which serve static files straight from S3, or to a file-storage
 * bucket).
 *
 * @internal Framework-only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Annotations } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

/** An ALB Lambda target's response JSON limit (1 MB). */
export const ALB_LAMBDA_RESPONSE_LIMIT = 1_000_000;
/** Lambda's synchronous response payload limit (6 MB), which binds under API Gateway's 10 MB. */
export const LAMBDA_SYNC_RESPONSE_LIMIT = 6 * 1024 * 1024;
/** Room for the response envelope and headers around the body. */
const ENVELOPE_BYTES = 2048;

/** The base64-encoded size of `bytes` bytes. */
const base64Size = (bytes: number): number => 4 * Math.ceil(bytes / 3);

/** Every file under `dir`, as `[urlPath, bytes]` (`urlPath` starts with `/`). */
const listFiles = (dir: string): Array<[string, number]> => {
  if (!fs.existsSync(dir)) return [];
  const out: Array<[string, number]> = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push([`/${path.relative(dir, full).split(path.sep).join('/')}`, fs.statSync(full).size]);
    }
  };
  walk(dir);
  return out;
};

/** A CloudFront behavior path pattern as a matcher (`*` matches any characters, `/` included). */
const behaviorMatcher = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;

/** What {@link warnOversizedProxyAssets} checks. */
export type ProxyAssetCheck = {
  /** The door's name in the message (e.g. `ALB`). */
  readonly door: string;
  /** The response limit in bytes. */
  readonly limitBytes: number;
  /** The limit as written in the message (e.g. `1 MB`). */
  readonly limitLabel: string;
  /** The build's static output directory. */
  readonly staticDir: string;
  /** The URL prefix the files are served under (basePath). @default '' */
  readonly urlPrefix?: string;
  /** Path patterns served elsewhere (e.g. from S3 by an edge in front); files they match are skipped. */
  readonly servedElsewhere?: readonly string[];
};

/**
 * Warn at synth (`@aws-blocks/hosting:AssetExceedsProxyLimit`) listing every
 * build asset whose base64-encoded response would exceed the door's limit.
 *
 * @param scope the construct to annotate.
 * @param check the door, its limit, and the build output.
 */
export const warnOversizedProxyAssets = (scope: IConstruct, check: ProxyAssetCheck): void => {
  const skip = (check.servedElsewhere ?? []).map(behaviorMatcher);
  const prefix = check.urlPrefix ?? '';
  const over = listFiles(check.staticDir)
    .map(([rel, bytes]) => [`${prefix}${rel}`, bytes] as const)
    .filter(([url]) => !skip.some((m) => m.test(url)))
    .filter(([, bytes]) => base64Size(bytes) + ENVELOPE_BYTES > check.limitBytes)
    .sort((a, b) => b[1] - a[1]);
  if (over.length === 0) return;
  Annotations.of(scope).addWarningV2(
    '@aws-blocks/hosting:AssetExceedsProxyLimit',
    `${over.length} build asset(s) are too large for the ${check.door} front door's asset proxy: a file is returned ` +
      `base64-encoded in the Lambda response, which is limited to ${check.limitLabel}, so these will fail to load: ` +
      `${over.map(([url, bytes]) => `${url} (${formatBytes(bytes)})`).join(', ')}. ` +
      'Serve them from the CloudFront door or the stacked door (static files come straight from S3), or from a file bucket.',
  );
};
