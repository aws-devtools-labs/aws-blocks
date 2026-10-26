import { startSandbox } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `npm run sandbox:deploy` passes --deploy-only: deploy once, write the config
// and client, then exit instead of starting CDK watch and the dev server.
startSandbox({
  deployOnly: process.argv.includes('--deploy-only'),
  backendPath: join(__dirname, '..', 'index.cdk.ts'),
  devCommand: 'npx tsx watch aws-blocks/scripts/server.ts',
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
