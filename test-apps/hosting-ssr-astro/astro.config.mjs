// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';

// `output` defaults to 'static' (no `output:` field) — Astro prerenders
// every page to its own `<path>/index.html` at build time. The Blocks Astro
// adapter detects the static `dist/` and emits a static-only DeployManifest
// (no SSR Lambda) with `staticAssets.spaFallback: false`, so the L3 uses
// directory-index resolution (each route serves its own page) rather than
// SPA fallback (every path → /index.html).
//
// The Preact integration enables Astro's Islands architecture: components
// are static HTML by default; only those marked with a `client:*` directive
// ship JavaScript and hydrate in the browser.
//
// `redirects` are lifted by the adapter onto the CloudFront viewer-request
// Function (edge redirect, no origin hit). `trailingSlash: 'ignore'` keeps
// both `/about` and `/about/` valid (matrix M1.4 / M1.5).
export default defineConfig({
  integrations: [preact()],
  trailingSlash: 'ignore',
  redirects: {
    '/old-home': '/',
  },
});
