---
"@aws-blocks/core": patch
---

fix(core): a stray SIGTERM no longer orphans cdk during a sandbox deploy or a destroy

`blocks deploy` defers a first SIGTERM while CloudFormation converges, but the sandbox deploy (`blocks sandbox deploy`, and the deploy before `blocks sandbox` watches) and the destroys ran cdk with no signal handling. One SIGTERM, which the `blocks` CLI forwards at once, killed the runner and left `cdk deploy` or `cdk destroy` running unwatched; the stack finished with nobody reporting it, and the immediate retry failed on the cdk lock that orphan still held.

- The sandbox synth and deploy, `destroySandbox()` and the production `destroy()` now run cdk as `deploy()` does: in its own process group, a first SIGTERM or a SIGHUP only prints `Ignoring SIGTERM: the deploy is still running …` (`the destroy …` for a destroy), and a second SIGTERM, or a Ctrl-C, stops the whole cdk tree.
- An operator stop throws `DeployProcessError` with `aborted: true` and the new `operatorSignal` (`SIGTERM` or `SIGINT`), so a launcher can exit 143 or 130 instead of reporting a failed deploy. A stopped sandbox deploy says `The sandbox deploy was stopped by SIGTERM.`, and a stopped destroy is not retried.
- `CdkOutput.run()` takes `deferSignals: true` for this; `decideSignalResponse()` takes the operation (`deploy` or `destroy`) as an optional last argument, and `runStreaming()` takes it as `operation`.
