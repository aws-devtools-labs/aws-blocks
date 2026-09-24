import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDevServer } from '@aws-blocks/blocks/scripts';

const __dirname = dirname(fileURLToPath(import.meta.url));

startDevServer({
	backendPath: join(__dirname, '..', 'index.ts'),
	port: 3001,
});
