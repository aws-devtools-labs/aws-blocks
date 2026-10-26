// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS Blocks' built-in default 404 page, and when a deploy gets it: a
 * multi-page static site (no server, no SPA fallback) that ships no 404 page
 * of its own and sets no `errorPages.notFound`. Decided once from the
 * manifest, for every front door: the CloudFront door wires it as a
 * CloudFront error response, the ALB and API Gateway doors serve it from
 * their asset proxy, and a bring-your-own door receives it as
 * `DoorInput.app.errorPages.notFound`. It is uploaded at
 * `builds/<buildId>/_not_found.html` (`NOT_FOUND_PAGE_KEY`).
 *
 * @internal Framework-only.
 */
import type { DeployManifest } from '../manifest/types.js';

/**
 * Whether the deploy serves the built-in default 404 page. Precedence: the
 * app's `errorPages.notFound`, then the framework's `errorPages[404]`, then
 * this default. An SPA keeps its `index.html` fallback (a miss is the app,
 * at 200), and a site with a server keeps its own 404.
 *
 * The SPA flag is the adapter's `staticAssets.spaFallback`, else the legacy
 * heuristic (no server and no error pages means an SPA).
 *
 * @param manifest the deploy manifest.
 * @param opts.hasCompute whether the deploy runs a server (or any regional compute).
 * @param opts.userNotFound whether the app set `errorPages.notFound`.
 * @internal Framework-only.
 */
export const needsDefaultNotFoundPage = (
  manifest: DeployManifest,
  opts: { hasCompute: boolean; userNotFound: boolean },
): boolean => {
  const isSpaFallback =
    manifest.staticAssets.spaFallback ??
    (!opts.hasCompute && (manifest.errorPages === undefined || Object.keys(manifest.errorPages).length === 0));
  return !opts.hasCompute && !isSpaFallback && !manifest.errorPages?.[404] && !opts.userNotFound;
};

// Built-in default 404 page for multi-page static sites that ship no
// 404.html of their own. Returned at HTTP 404 (not the SPA 200 fallback)
// so crawlers and clients see a correct not-found status.
export const DEFAULT_NOT_FOUND_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>404 — Page Not Found</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb;color:#374151}
.c{text-align:center;max-width:480px;padding:2rem}h1{font-size:1.5rem;margin-bottom:.5rem}p{color:#6b7280}</style></head>
<body><div class="c"><h1>404 — Page Not Found</h1><p>The page you're looking for doesn't exist.</p></div></body></html>`;
