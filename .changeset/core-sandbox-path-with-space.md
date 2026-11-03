---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): `cdk-blocks sandbox` and `sandbox deploy` work in a project path that contains a space

CDK runs the sandbox's `--app` command through a shell. The synth step, the deploy fallback and `cdk watch` passed the backend path unquoted, so a path such as `~/My Projects/app` split in two and synth failed. Only `sandbox destroy` quoted it. All four now share one `--app` command that names no path: the backend path goes to the cdk child in its environment (`BLOCKS_CDK_APP_ENTRY`), and the shell reads it inside double quotes, so a space, a quote, `$` or `%` in the path stays part of it.
