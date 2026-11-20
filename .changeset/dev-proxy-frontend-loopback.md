---
"@aws-blocks/core": patch
---

fix: the dev server reaches Vite when it listens only on `::1`

Vite defaults to `localhost` and can bind only to `::1`. When the dev server's frontend proxy resolved `localhost` to a
different address family, pages returned `502 Frontend server unavailable` even though the dev server reported ready.
The proxy now targets the loopback address Vite answered on during the readiness check. If Vite later restarts and
rebinds to the other family, the proxy re-checks after a refused connection, so the next request and HMR reconnect
reach it. Existing apps work without changing their frontend command.
