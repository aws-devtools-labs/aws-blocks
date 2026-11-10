---
'@aws-blocks/core': patch
---

Registering a telemetry framework sink now also removes the process `exit` listener that was added to clean it up. Long-running processes that deploy repeatedly, such as watch and sandbox loops, no longer gain one `exit` listener per deploy, which eventually triggered `MaxListenersExceededWarning`. A sink that is never registered is still removed when the process exits.
