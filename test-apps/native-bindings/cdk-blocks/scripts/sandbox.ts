import { startSandbox } from 'aws-cdk-blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

startSandbox({
  backendPath: join(__dirname, '..', 'index.cdk.ts')
});
