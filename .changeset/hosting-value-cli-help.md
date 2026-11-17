---
"@aws-blocks/hosting": minor
---

feat(hosting): `secret` and `config` CLIs print help for `--help` and `-h`

`hosting-secret`, `hosting-config` and the `runSecretCli` / `runConfigCli` commands of `@aws-blocks/core/scripts` built on them now print usage for `set`, `list` and `remove` when `--help` or `-h` appears anywhere in the arguments, and exit 0. The help lists each command's flags and shows where `--stage <name>` stores a value (`<prefix>/<name>/<KEY>` instead of the shared `<prefix>/<KEY>`; any name is accepted), with the prefix in effect. Before, `--help` was read as a key or ignored, so `remove KEY --help` deleted the value; a help request now returns before any prompt or AWS call. Without `--help`, every command behaves as before.

For tools that wrap this CLI, `runValueCli` takes two new options. `interactive: false` refuses the hidden value prompt, with an error that names `--value-stdin`, even on a terminal. `yes: true` confirms `remove --force`, as `--yes` in the arguments does. A usage problem (a missing key, an unknown subcommand, a flag without its value, or a prompt or confirmation the run cannot give) throws the newly exported `ValueCliUsageError`, so a wrapper can tell it apart from an AWS failure.
