// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    conditions: ['browser']
  },
  server: {
    port: 3000
  },
  build: {
    outDir: 'dist'
  }
});
