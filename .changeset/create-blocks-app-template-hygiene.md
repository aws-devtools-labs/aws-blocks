---
"@aws-blocks/create-blocks-app": patch
---

Template hygiene: add missing READMEs, fix the `react` spec script, drop a dead dependency.

Three small fixes across the scaffolded templates:

- **READMEs** — `demo`, `nextjs`, and `auth-cognito` had none, while every other
  non-overlay template ships one. Each now has a README with a description of what
  it demonstrates, the project structure, and the standard command block including
  the destroy commands. A scaffolded app is a copy-and-learn surface, so the README
  is the first thing a developer reads.
- **`react` spec script** — the `react` template was the only one missing
  `"spec": "blocks-generate-spec"`, so `npm run spec` failed there while it worked
  in every sibling. Added, matching the sibling templates.
- **`backend` dependency** — the `backend` template declared `@aws-blocks/hosting`
  but is frontend-less and imports nothing from it. Removed, matching the
  `api-only` and `sql` headless templates.
