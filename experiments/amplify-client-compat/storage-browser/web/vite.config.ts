import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';

// Two modes:
// - Hosted (BLOCKS_HOSTED=1, run by the Blocks Hosting block during synth): the
//   Blocks API is on the same CloudFront domain at /aws-blocks/api, and the
//   region comes from the synth environment.
// - Local dev: proxy to the deployed API from the amp-storage-browser deploy
//   outputs (cdk deploy --outputs-file ../.live/outputs.json) so its session
//   cookie is first-party. S3 traffic from <StorageBrowser> goes straight to
//   the bucket (CORS).
const hosted = process.env.BLOCKS_HOSTED === '1';
const outputsFile = new URL('../.live/outputs.json', import.meta.url);
const outputs =
	!hosted && existsSync(outputsFile)
		? (Object.values(JSON.parse(readFileSync(outputsFile, 'utf-8')))[0] as Record<string, string>)
		: undefined;
const api = outputs ? new URL(outputs.ApiUrl) : undefined;
const region = outputs?.AmplifyRegion ?? process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION;
if (!region) throw new Error('set AWS_REGION for the hosted build');

export default defineConfig({
	plugins: [react()],
	define: {
		__REGION__: JSON.stringify(region),
		__API_PATH__: JSON.stringify(api ? api.pathname : '/aws-blocks/api'),
	},
	build: { outDir: 'dist', emptyOutDir: true },
	server: {
		host: '127.0.0.1',
		port: 5173,
		strictPort: true,
		proxy: api ? { [api.pathname]: { target: api.origin, changeOrigin: true, cookieDomainRewrite: '' } } : undefined,
	},
});
