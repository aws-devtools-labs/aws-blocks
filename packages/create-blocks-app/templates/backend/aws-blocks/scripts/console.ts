import { openConsole, parseStageArg } from '@aws-blocks/blocks/scripts';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The stack to open is derived from the STAGE, never from a position in an
// outputs file: `npm run sandbox:console` opens this machine's sandbox stack,
// `npm run console` passes --production and opens the production stack.
openConsole({
  projectRoot: join(__dirname, '..', '..'),
  stage: parseStageArg(process.argv.slice(2)),
});
