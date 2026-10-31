---
"@aws-blocks/create-blocks-app": patch
---

feat(create-blocks-app): show greet errors in the Next.js template with the StatusMessage UI primitive

The Next.js template's client greeting previously gave no feedback when the greet call failed — the button stopped loading and nothing appeared. It now reports the failure in a shared `StatusMessage` region (a polite ARIA live region themed by the `--bb-*` design tokens), which clears on the next successful greet.
