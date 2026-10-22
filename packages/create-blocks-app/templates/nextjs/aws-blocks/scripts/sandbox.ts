import { startSandbox } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `npm run sandbox:preview` passes --preview: deploy the app hosted in preview
// shape (no local dev server); re-deploys hotswap code changes.
const preview = process.argv.includes('--preview');

startSandbox({
  backendPath: join(__dirname, '..', 'index.cdk.ts'),
  preview,
  deployOnly: preview,
  devCommand: 'npx tsx watch aws-blocks/scripts/server.ts',
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
