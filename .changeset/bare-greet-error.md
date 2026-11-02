---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): show a greet error in the bare template instead of a blank page

The bare template's page previously stayed blank when the startup `greet()` call failed, with only an unhandled rejection in the console. It now shows the failure in a shared `StatusMessage` error line (a polite ARIA live region themed by the `--bb-*` design tokens).
