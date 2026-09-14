---
"@aws-blocks/bb-agent": patch
"@aws-blocks/blocks": patch
---

docs(bb-agent): add a concrete React `useChat` example

The `useChat` docs only showed the framework-agnostic callback form and warned
that it is "a factory function, not a React hook — call it once, not on every
render," without demonstrating the fix. Added a primary React example that holds
the instance in a `useRef` (created lazily so it survives re-renders), bridges
`onMessagesChange` / `onLoadingChange` into `useState`, cleans up with
`chat.destroy()` on unmount, and renders messages plus a send handler — directly
resolving the "call once" footgun. Included a one-line Next.js note (same
component, keep the `'use client'` directive) and kept the existing
framework-agnostic example as the baseline.
