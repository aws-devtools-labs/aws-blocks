---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): the dev server no longer kills other processes that hold its port or frontend port

At startup the dev server sent SIGTERM, then SIGKILL, to any process listening on its port or frontend port, on the assumption that it was a leftover of its own. That killed unrelated servers, and when two apps shared a frontend port, the second app's dev server killed the first app's frontend.

The dev server now records its frontend's process group in its pidfile. At startup it stops a listener only if that listener is in the frontend group recorded by this app's previous dev server, for example a Vite left behind when that dev server crashed. If anything else holds the port, the dev server stops nothing and exits with code 1, naming the process: `port 3100 is in use by pid 4242 (…)`. The message tells you to stop that process or choose another port with `--port` / `--frontend-port`. On Windows, where process groups aren't recorded, no listener is ever stopped.
