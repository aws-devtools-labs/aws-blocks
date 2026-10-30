---
"@aws-blocks/blocks": patch
---

fix(blocks): `blocks` help never runs a command, and confirmations name the real credentials

- Help never runs a command. `-h` or `--help` anywhere after `blocks secret`, `blocks config`, `blocks db` or `blocks vendorize` shows help instead of running the tool with your arguments, so `blocks config remove KEY --help` never deletes `KEY`. `blocks help secret remove KEY` and `blocks db pull ./out --help` forward only `remove --help` or `pull --help` to the tool, which prints that command's usage; `blocks help vendorize <package>` and `blocks vendorize <package> --help` print the CLI's help. `blocks-vendorize --help` prints its usage and exits before it copies or installs anything.
- Confirmations name the real credentials. `blocks destroy`, `blocks deploy` and the sandbox commands describe the credentials as the deploy does, for example `access keys in AWS_ACCESS_KEY_ID (used instead of AWS_PROFILE)`. When environment access keys override an exported `AWS_PROFILE` or `--profile`, they print a warning, even with `--quiet`.
- `--verbose` masks the password of a URL (`postgres://user:***@host`) and the value of `--url` when it echoes a child command line.
- `--region` and `AWS_REGION` must be an AWS Region code such as `us-east-1`, `us-gov-west-1` or `cn-north-1`; anything else is a usage error (exit 2). On Windows, the sandbox dev command refuses a path that contains `"` or `%`, which the Windows shell cannot quote safely.
