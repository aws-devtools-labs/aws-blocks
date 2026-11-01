---
"@aws-blocks/bb-data": patch
---

fix(bb-data): the verb usage names the command that runs the CLI

`bb-data <verb> --help` prints `Usage: <command> <verb> …`, where `<command>` is `BB_DATA_COMMAND` when a wrapper sets it, else `bb-data`. `blocks db <verb> --help` sets it, so its usage reads `Usage: blocks db migrate …` instead of `Usage: bb-data migrate …`.
