---
'@aws-blocks/core': patch
---

`blocks-telemetry --disable` (without `--global`) now exits non-zero and writes nothing when it finds no project root, the nearest directory at or above the working directory that holds both a `package.json` and an `aws-blocks/` directory. Previously it fell back to the working directory, so running it from a monorepo root whose app is nested below wrote an opt-out the app never read and still reported success. The error points at `--global` and `AWS_BLOCKS_DISABLE_TELEMETRY=1`. `--disable` now also prints its success line only after reading the status back and confirming telemetry is off. `--enable`, `--status` and `--global` are unchanged.
