import { runStopCli } from '@aws-blocks/blocks/scripts';

// Stop the local dev server(s) this app started (`npm run dev`). Targets the
// recorded listener by PID — never a name match like `pkill -f tsx`, which would
// also kill your own shell. Pass `--port <n>` to target a specific port.
await runStopCli();
