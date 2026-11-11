---
'@aws-blocks/core': patch
'@aws-blocks/blocks': patch
---

`blocks-telemetry --disable` and `--enable` (without `--global`) now write `.blocks/config.json` at the project root, the nearest directory at or above the working directory that holds a `package.json` and an `aws-blocks/` directory. Run from a subdirectory of an app, `--disable` previously wrote the opt-out into that subdirectory, where the telemetry check never read it, so telemetry kept sending while the command reported success. When no project root is found, `--enable` uses the working directory, while `--disable` writes nothing and exits non-zero (for example at a monorepo root whose app is nested below it), pointing at `--global` and `AWS_BLOCKS_DISABLE_TELEMETRY=1`. `--status` reads the same project root as `--enable`. `--disable` reads the status back and prints its success line only after confirming telemetry is off; otherwise it prints a warning and exits non-zero. `--global` is unchanged.
