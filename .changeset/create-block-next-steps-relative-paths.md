---
'@aws-blocks/create-block': patch
---

Fix the "Next steps" output so its paths work from where you ran the CLI. In contributor and customer mode, the "Implement the API" step now names the generated package's `src/` relative to the current directory instead of assuming the repository root. In external mode, the `cd` hint prefixes `./` to a target that starts with `-`, `=` or another character a shell could misread, so `--dir ./-x` prints `cd ./-x` rather than `cd -x`.
