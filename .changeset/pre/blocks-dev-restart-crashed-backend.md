---
"aws-cdk-blocks": patch
---

fix: `npm run dev` restarts a dev server that crashes after it started

Before, when the backend crashed after the dev server had started (an uncaught exception outside any request, or a `process.exit(1)` in the backend), `tsx watch` kept running with no dev server under it. The app stayed down until the next file change, and nothing said it would.

- `npm run dev` now prints `⚠️  The dev server crashed (exit code N); restarting it in … ms (restart k of 5 within 60 s).` and starts the dev server again. The backoff starts at 500 ms and doubles up to 5 s.
- After 5 restarts within 60 s, the next crash ends `npm run dev` with exit code 1, and the error says to fix the error and run `npm run dev` again.
- A Ctrl-C, a SIGTERM or `npm run dev:stop` stops it, during a restart's backoff too, and the crashed dev server is not started again. A failed start of the first dev server or of a reload is handled as before, and so is a dev server that a signal killed. A restarted dev server that fails to start ends `npm run dev`, as a failed first start does.
