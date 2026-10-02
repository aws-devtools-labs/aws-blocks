---
"@aws-blocks/auth-common": minor
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
---

feat: shared, framework-neutral `ui-theme` design-token layer

Introduce a design-token layer for the Blocks UI so the shared Auth
components and the starter templates share one consistent, polished look
with no new runtime framework dependency.

- `@aws-blocks/auth-common` ships a new theme module: CSS custom
  properties (`--bb-*` for color, spacing, radius, typography, elevation)
  on `:root`, a light and dark palette driven by `prefers-color-scheme`
  with a `data-bb-theme` override hook, and base `.bb-*` component
  classes. A new idempotent, SSR-safe `injectTheme()` adds the stylesheet
  to the document once. The shared `Authenticator`, `AccountMenuBar`, and
  `AuthenticatedContent` now render against these token classes instead
  of inline styles and inject the theme themselves, so the themed look
  travels with the component into any host (lit-html, vanilla, React,
  Next.js) with zero wiring. Every `data-testid` is preserved.
- `@aws-blocks/blocks` re-exports `injectTheme`, `THEME_CSS`, and
  `THEME_STYLE_ID` from `@aws-blocks/blocks/ui`.
- `@aws-blocks/create-blocks-app` templates (`default`, `react`,
  `nextjs`, `demo`, `auth-cognito`) adopt the tokens for their own page
  chrome and todo UI, so the whole page is themed and dark-mode-aware;
  the `bare` template stays deliberately minimal.

Additive and non-breaking.
