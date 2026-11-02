// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The CloudFront custom error responses for the app's own error pages
 * (`errorPages.notFound` → `404.html`, `errorPages.serverError` → `500.html`).
 * One implementation, used by the built-in CloudFront door (`CdnConstruct`)
 * and by `cf.errorPages` for a bring-your-own door.
 *
 * @internal Framework-only.
 */
import { Duration } from 'aws-cdk-lib';
import type { ErrorResponse } from 'aws-cdk-lib/aws-cloudfront';

/** Inputs to {@link customErrorResponses}. */
export type CustomErrorResponsesOptions = {
  /** Path the pages are served under, no trailing slash (`/builds/<buildId>` on the built-in door, `''` at an asset origin's root). */
  readonly pathPrefix: string;
  /** Whether the app renders on a server: the 502/503/504 pages are then the server's own. */
  readonly hasCompute: boolean;
  /**
   * Whether the pages are object keys under `pathPrefix` (`DoorInput.app.errorPages`:
   * the app's `404.html`, a framework page, or the default `_not_found.html`),
   * served at those keys. Otherwise they are the app's local files, uploaded
   * as `404.html` / `500.html` (the built-in CloudFront door). @default false
   */
  readonly pageKeys?: boolean;
};

/**
 * The custom error responses for the app's error pages.
 *
 * - `notFound` → 404 serves `<pathPrefix>/404.html` (not cached), or
 *   `<pathPrefix>/<notFound>` with `pageKeys`.
 * - `serverError` → 500 serves `<pathPrefix>/500.html` (or `<pathPrefix>/<serverError>`
 *   with `pageKeys`); for an app without a server also 502, 503 and 504 (cached 10 s).
 *
 * @param pages which error pages the app configured.
 * @param options where the pages are served from, and whether the app has a server.
 * @returns the error responses, in that order (empty when no page is configured).
 */
export function customErrorResponses(
  pages: { readonly notFound?: unknown; readonly serverError?: unknown } | undefined,
  options: CustomErrorResponsesOptions,
): ErrorResponse[] {
  const responses: ErrorResponse[] = [];
  const pagePath = (page: unknown, uploadedAs: string): string =>
    `${options.pathPrefix}/${options.pageKeys && typeof page === 'string' ? page.replace(/^\/+/, '') : uploadedAs}`;
  if (pages?.notFound) {
    responses.push({
      httpStatus: 404,
      responseHttpStatus: 404,
      responsePagePath: pagePath(pages.notFound, '404.html'),
      ttl: Duration.seconds(0),
    });
  }
  if (pages?.serverError) {
    // For compute (SSR) stacks, the default 502/503/504 error pages are
    // already wired by the door; only add 500 with the custom page.
    // For static/SPA stacks, add all server error statuses.
    const serverErrorStatuses = options.hasCompute ? [500] : [500, 502, 503, 504];
    for (const status of serverErrorStatuses) {
      responses.push({
        httpStatus: status,
        responseHttpStatus: status,
        responsePagePath: pagePath(pages.serverError, '500.html'),
        ttl: Duration.seconds(10),
      });
    }
  }
  return responses;
}
