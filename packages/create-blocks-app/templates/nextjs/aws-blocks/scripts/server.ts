import { startDevServer } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

startDevServer({
  backendPath: join(__dirname, '..', 'index.ts'),
  // --hostname 127.0.0.1: `next dev` binds every interface by default; keep the
  // frontend dev server (source, HMR) on loopback like the Blocks dev server.
  frontendCommand: 'npx next dev --webpack --hostname 127.0.0.1 --port 3100',
  frontendPort: 3100,
});
