---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): keep the dev server, sandbox, deploy and destroy running when their output pipe or terminal closes

When stdout or stderr lost its reader, the next log line crashed the process with `write EPIPE` (a closed pipe) or `write EIO` (a closed terminal). That happened with `cdk-blocks sandbox 2>&1 | tee log` after a Ctrl-C, which also stops `tee`. It also happened with a background `npm run dev &` whose pipe went away, and when you closed the terminal mid-deploy. A piped `cdk-blocks sandbox` crashed before it reaped `cdk watch` and the dev server, so `cdk watch` kept deploying to AWS. A deploy whose terminal closed died with its CDK child, so nothing recorded the result.

- The dev server, `startSandbox`, `destroySandbox`, `deploy` and `destroy` now ignore those write errors and drop the output that can't be written. Any other stream error still ends the process. The shared helper is exported from `@aws-blocks/core/scripts` as `ignoreClosedOutput()`, and the error codes it drops as `CLOSED_OUTPUT_CODES`.
- On Ctrl-C, `cdk-blocks sandbox` reaps `cdk watch` and the dev server first and prints only after that. Its message is now `🛑 Stopped local processes.`
