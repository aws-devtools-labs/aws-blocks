---
"@aws-blocks/blocks": patch
---

fix(blocks): `blocks` on Windows

- Ctrl-C in `blocks dev` on Windows no longer prints `ps: unknown option -- A` when Git for Windows' `ps` is on `PATH`: the CLI runs no `ps` there, and on POSIX `ps`'s errors no longer reach the terminal.
