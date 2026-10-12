import { runStatusCli } from '@aws-blocks/blocks/scripts';

// Report whether a local dev server is running (read-only). Pass `--port <n>` to
// check a specific port.
await runStatusCli();
