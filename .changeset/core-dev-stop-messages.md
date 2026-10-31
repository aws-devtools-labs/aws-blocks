---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): clearer `dev stop` results when another process holds the port, and no stuck garbage pidfiles

- When no dev server of this app runs but another process holds the port, `dev stop` used to say "No dev server was running on :3000 (nothing to stop)". Now it says the port is held by another process that was not stopped, and names it by pid and command. `StopResult` has a new `holders` field with those processes.
- `dev stop` (and `dev stop --all`) now removes a pidfile it can't parse. Before, that pidfile stayed forever, so `--all` kept listing its port.
- A recorded dev-server pid that the OS has reused for another command now counts as stopped.
- The template `dev:stop` script prints its "port is still bound" warning to stderr instead of stdout. `isStopWarning(result)` is exported for callers that route the message themselves.
