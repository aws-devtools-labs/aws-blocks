---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): keep todo errors visible in the demo template

In the demo template, a failed toggle, priority change or title edit showed its error and then reloaded the list, and the reload cleared the error straight away. The list now reloads first and the error is shown afterwards, so it stays on screen.
