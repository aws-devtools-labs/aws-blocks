---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): stream CloudFormation progress to stdout and stop a stray SIGTERM from killing an in-flight deploy

`npm run deploy` wrote nothing to stdout for the whole CloudFormation phase, and
a backgrounded deploy was killed (exit 143) while CloudFormation kept going and
finished server-side. Callers had no progress signal, could not tell success from
failure, and re-ran deploys that had actually worked.

Two causes, both fixed:

- The CDK CLI picks its log stream as `isCI ? stdout : stderr`, so every
  CloudFormation event went to stderr and `npm run deploy > deploy.log` captured
  zero bytes. The deploy now passes `--ci` (log lines on stdout, errors still on
  stderr) and `--progress events` (one line per resource transition instead of a
  progress bar that needs a TTY).
- The deploy ran `cdk deploy` through a blocking synchronous spawn with the child
  in this process's group, so signals could not be handled and the default
  SIGTERM disposition killed the CLI mid-deploy. The CDK CLI is now spawned in
  its own process group with its output piped and relayed line by line as it
  arrives, plus an idle heartbeat while a slow resource is converging. A single
  SIGTERM, or any SIGHUP, no longer abandons a converging deploy: it logs and
  keeps streaming. Ctrl-C, or a second SIGTERM, aborts and reaps the CDK process
  tree.

The deploy also prints its terminal status on stdout for both success and
failure, so a caller that only captures stdout can tell the two apart.
