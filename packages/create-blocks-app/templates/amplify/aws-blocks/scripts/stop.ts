import { runStopCli } from '@aws-blocks/blocks/scripts';

// Stop the local Blocks dev server this app started (`npm run blocks:dev`).
// SIGTERMs the recorded `tsx watch` supervisor by PID — never a name match like
// `pkill -f tsx`, which would also kill your own shell. The Amplify overlay's
// dev server binds :3001; pass `--port <n>` to override.
await runStopCli(process.argv.slice(2).length ? process.argv.slice(2) : ['--port', '3001']);
