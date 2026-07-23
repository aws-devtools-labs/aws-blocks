// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // The Blocks SvelteKit adapter runs this Node server on Lambda via the
    // Lambda Web Adapter. `out: 'build'` is the default; declared explicitly so
    // the hosting adapter's `buildOutputDir: 'build'` matches.
    adapter: adapter({ out: 'build' }),
  },
};

export default config;
