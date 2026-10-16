import { dashboard } from '@aws-blocks/blocks/scripts';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

dashboard({
  projectRoot: join(__dirname, '..', '..')
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
