import { startDevServer } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

startDevServer({
  backendPath: join(__dirname, '..', 'index.ts'),
  frontendCommand: 'npx vite --port 3100 --strictPort',
  frontendPort: 3100,
});
