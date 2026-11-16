---
'@aws-blocks/blocks': minor
'@aws-blocks/create-blocks-app': minor
---

**Breaking: `cdk-blocks` results are JSON when stdout isn't a terminal; pass `--output text` for text.** Without `--output`, the commands with a JSON result (`deploy`, `sandbox deploy`, `sandbox preview`, `whoami`, `dev stop` and `migrate`) now print exactly what `--output json` prints when their stdout is a pipe or a file: one JSON document on stdout, with progress and the output of CDK and other child tools, the `BLOCKS_DEPLOYED` line among it, on stderr. In a terminal they print text as before. An explicit `--output text` or `--output json` always wins, and `--query` is unchanged. Every other command prints text whatever stdout is, and still exits 2 with an explicit `--output json`.

This covers the npm scripts that create-blocks-app generates, which call these commands without `--output`: piped or redirected, `npm run deploy`, `npm run sandbox:deploy` and `npm run sandbox:preview` print `{apiUrl, url, stack, account, region}` (and `live` for `deploy`), in CI too. Run them as `npm run -s deploy` to keep npm's own `> <app>@<version> deploy` lines off stdout, so that stdout is only the JSON document. `npm run deploy -- --output text` prints text. The scaffolded `AGENTS.md` tells coding agents to read the JSON result.
