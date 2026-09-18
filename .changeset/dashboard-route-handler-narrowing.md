---
"@aws-blocks/bb-dashboard": patch
---

test(dashboard): narrow the optional route handler before invoking it

`RegisteredRoute.handler` is now optional (routing-only entries carry no
handler), so the dashboard route tests assert the handler is present before
calling it. Test-only — no change to the dashboard's runtime behavior.
