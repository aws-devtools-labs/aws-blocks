import { startDevServer } from 'aws-cdk-blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

startDevServer({
  backendPath: join(__dirname, '..', 'index.ts'),
  port: 3001,
});
