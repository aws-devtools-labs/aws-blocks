---
'@aws-blocks/blocks': minor
'@aws-blocks/create-blocks-app': minor
---

Register `dashboard` as a task, so the Blocks dashboard is reachable from the runner that every other lifecycle command lives in: `npm run dashboard` serves the Admin UI for the app it is run from, and `npm run dashboard:doctor` prints a diagnosis instead when the server will not start. The task takes `-- --port`, `-- --no-open` and a repeatable `-- --allow-origin`; `--profile` and `--region` are the runner's own global options, and the project is the one the runner resolves, so the dashboard needs neither `--project` nor its own copies of those.

The default template gains both `dashboard` and `dashboard:doctor` scripts.

Neither task has a structured result, so `-- --output json` is refused for both with the runner's own message: the doctor's machine-readable report is not wired through yet. `--allow-origin` is checked before the dashboard starts and passed on as a canonical origin, so a value the dashboard would have dropped (`*`, a bare hostname, a path) is refused rather than silently trusting nothing. A run that cannot prompt (no TTY, `--no-input` or `CI`) gets no stdin, so the offer to install `@aws-blocks/admin-ui` reports how to install it by hand instead of waiting for an answer, and a Ctrl-C at that prompt exits 130 as an interruption rather than 1.
