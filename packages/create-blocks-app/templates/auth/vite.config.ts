import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    conditions: ['browser']
  },
  build: {
    outDir: 'dist'
  }
});
