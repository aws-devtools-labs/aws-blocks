// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import type { NextConfig } from 'next';

// Next compiles this file to CJS, so `import.meta.url` is unavailable here.
// `next build` runs with the app directory as cwd.
const REPO_ROOT = join(process.cwd(), '..', '..');

const nextConfig: NextConfig = {
	output: 'standalone',
	// Pin the trace root so the standalone output path is deterministic for the test.
	outputFileTracingRoot: REPO_ROOT,
	// Blocks that load WASM or native assets via `new URL(..., import.meta.url)` must
	// not be bundled: the bundler rewrites the URL and asset loading breaks. Both
	// Turbopack and webpack fail identically without this. Leaving them external also
	// hands resolution back to Node, which honors custom conditions.
	serverExternalPackages: ['@aws-blocks/bb-data', '@electric-sql/pglite'],
};

export default nextConfig;
