import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// Deploy outputs of the amp-liveness stack (cdk deploy --outputs-file).
const outputs = Object.values(JSON.parse(readFileSync(new URL('../.live/outputs.json', import.meta.url), 'utf-8')))[0] as Record<string, string>;
const api = new URL(outputs.ApiUrl);

export default defineConfig({
	plugins: [react()],
	define: { __API_PATH__: JSON.stringify(api.pathname) },
	server: {
		host: '127.0.0.1',
		port: 5174,
		strictPort: true,
		// Same-origin proxy to the Blocks API so its session cookie is first-party.
		// Video goes straight from the browser to Rekognition streaming.
		proxy: { [api.pathname]: { target: api.origin, changeOrigin: true, cookieDomainRewrite: '' } },
	},
});
