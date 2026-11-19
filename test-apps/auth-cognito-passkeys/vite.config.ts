import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    conditions: ['browser'],
    alias: {
      // The inner workspace is named `auth-cognito-passkeys-aws-blocks`
      // (npm requires unique names across the monorepo, and the
      // `cdk-blocks` slot is already taken by `test-apps/comprehensive`).
      // The demo source still imports `from 'cdk-blocks'` so the sample
      // reads cleanly; Vite resolves it to the same `client.js` the dev
      // server regenerates on every backend change.
      'cdk-blocks': resolve(__dirname, 'cdk-blocks/client.js'),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
  },
});


