---
"@aws-blocks/blocks": patch
---

fix(blocks): a SIGTERM to `cdk-blocks dev` waits for its runner's cleanup on procps-ng 3.3.10 too

- The CLI lists a watcher's children with `ps -A -o pid= -o ppid=`. On procps-ng 3.3.10 (CentOS 7, Amazon Linux 2), `-o pid=,ppid=` printed a single pid column, so the CLI found no runner, skipped its SIGTERM and cleanup wait, and stopped `tsx watch` straight away.
