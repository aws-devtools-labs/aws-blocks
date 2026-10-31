---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): `blocks sandbox` and `sandbox deploy` work in a project path that contains a space

CDK runs the sandbox's `--app` command through a shell. The synth step, the deploy fallback and `cdk watch` passed the backend path unquoted, so a path such as `~/My Projects/app` split in two and synth failed. Only `sandbox destroy` quoted it. All four now share one quoted `--app` command: single quotes on POSIX, double quotes on Windows.
