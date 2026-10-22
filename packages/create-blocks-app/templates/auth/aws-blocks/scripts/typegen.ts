import { runTypegenCli } from '@aws-blocks/blocks/scripts';

// Generate .blocks/hosting-values.d.ts so getSecret()/getConfig() autocomplete your
// declared secret()/config() keys and reject typos — no call-site change.
// `npm run typegen`            — regenerate
// `npm run typegen -- --check` — CI: fail if stale
runTypegenCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
