---
'@aws-blocks/core': patch
'@aws-blocks/blocks': patch
---

`blocks-telemetry --disable` and `--enable` (without `--global`) now write `.blocks/config.json` at the project root, the nearest directory above the working directory that holds a `package.json` and an `aws-blocks/` directory, falling back to the working directory when there is none. Run from a subdirectory of an app, `--disable` previously wrote the opt-out into that subdirectory, where the telemetry check never read it, so telemetry kept sending while the command reported success. `--status` reads the same project root, and `--disable` now also reads the status back and prints a warning and exits non-zero if telemetry is still enabled. `--global` is unchanged.
