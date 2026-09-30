import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built by the Blocks `Hosting` block during `cdk synth` and served from the
// same CloudFront domain as the Blocks API (`/aws-blocks/api`). Pool facts are
// read at runtime from `/.blocks-sandbox/config.json`, so the build does not
// need the stack's outputs.
export default defineConfig({
	plugins: [react()],
	build: { outDir: 'dist', emptyOutDir: true },
});
