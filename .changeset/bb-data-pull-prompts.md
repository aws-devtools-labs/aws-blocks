---
"@aws-blocks/bb-data": patch
---

`bb-data pull` no longer shows the connection string as you type or paste it, and a paste that ends in Enter is submitted at once. Ctrl-C at any of its prompts now exits with code 130, and closing stdin (Ctrl-D) before answering exits with code 1 and `stdin closed before an answer was given.` Previously both exited 0 without a message.
