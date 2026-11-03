---
"@aws-blocks/blocks": patch
---

fix(blocks): `cdk-blocks dev stop` prints a still-bound port on stderr and names the process that holds a port

- When the dev server was signalled but its port is still bound afterwards, the message now goes to stderr instead of stdout, and the command still exits 1. Stdout keeps only outcomes.
- When no dev server of the app is running but another process holds the port, the message names that process (`pid 777 (python3 -m http.server 3000)`), and `--output json` reports it under `stopped[].holders` as `{pid, command}`.
