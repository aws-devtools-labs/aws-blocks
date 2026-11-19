import { startDevServer } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

startDevServer({
  backendPath: join(__dirname, '..', 'index.ts'),
  // The launcher (run-e2e.sh / CI) picks a free port and passes it via PORT so
  // the server and the e2e client agree on it without a hardcoded literal.
  // 3001 stays the fallback for a plain `npx tsx server.ts`.
  port: Number(process.env.PORT) || 3001
});
