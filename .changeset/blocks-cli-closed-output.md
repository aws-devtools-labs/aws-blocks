---
"@aws-blocks/blocks": patch
---

fix(blocks): a closed terminal or pipe no longer kills the `blocks` CLI while its runner still works

The CLI parent had no handler for a failed write to stdout or stderr. After `blocks sandbox | tee log` lost `tee` to a Ctrl-C, or after the terminal closed, its next write raised `EPIPE` or `EIO`, which ended the CLI while the runner below it was still cleaning up or deploying. The CLI now drops those write errors, as the runners already do.
