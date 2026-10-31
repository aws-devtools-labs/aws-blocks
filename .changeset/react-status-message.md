---
"@aws-blocks/create-blocks-app": patch
---

feat(create-blocks-app): show todo errors in the React template with the StatusMessage UI primitive

The React template previously gave no feedback when loading, adding, or deleting a todo failed — the list simply did not change. It now reports those failures in a shared `StatusMessage` region (a polite ARIA live region themed by the `--bb-*` design tokens), which clears on the next successful action. A failed add keeps the typed title in the input so it can be retried.
