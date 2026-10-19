import { startSandbox } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

startSandbox({
  backendPath: join(__dirname, '..', 'index.cdk.ts'),
  devCommand: 'npx tsx watch aws-blocks/scripts/server.ts',
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
