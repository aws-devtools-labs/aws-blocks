---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): show todo and last-code errors in the `auth` template

In the `auth` template, a failed toggle, priority change, title edit or delete previously did nothing visible, and a failed title edit left the unsaved text in the input. These now reload the list, so the row shows the saved value again, and report the failure in the existing todo status line. A failed "Show last code" lookup now shows an error instead of an unhandled rejection.
