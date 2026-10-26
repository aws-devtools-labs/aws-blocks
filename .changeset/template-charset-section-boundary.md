---
"@aws-blocks/create-blocks-app": patch
---

Templates: the `nextjs` template now wraps each page section in a `SectionBoundary` error boundary (`src/app/section-boundary.tsx`), so a section that fails, such as a Server Component whose API call throws, shows an inline error with a retry button instead of replacing the whole page through the route-level `error.tsx`. The `demo` template's `index.html` now declares `<meta charset="utf-8">`, so hosts that serve HTML without a charset no longer make the browser decode the page as windows-1252.

Existing apps can adopt both: copy `section-boundary.tsx` into `src/app/` and wrap each section's content in `<SectionBoundary>`, and add `<meta charset="utf-8">` as the first element of `<head>`.
