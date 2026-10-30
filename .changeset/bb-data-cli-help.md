---
"@aws-blocks/bb-data": patch
---

fix(bb-data): `bb-data <command> --help` prints that command's usage

`bb-data migrate --help`, `status --help`, `generate-types --help` and `pull --help` (or `-h`) now print the usage and options of that command and exit 0. Before, `migrate --help` read `--help` as the migrations directory and exited 1, and `pull --help` failed without a terminal. `--help` is checked first, wherever it appears in the arguments, so a help request never opens, migrates or introspects a database and never prompts. `bb-data --help` prints the overview of every command. Without `--help`, every command behaves as before.
