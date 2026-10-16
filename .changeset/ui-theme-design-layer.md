---
"@aws-blocks/auth-common": minor
"@aws-blocks/blocks": minor
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
  classes. The palette declares `color-scheme` so UA-drawn widgets
  (checkboxes, `<select>`, scrollbars, `::placeholder`, autofill) follow
  the active palette, and `.bb-button` has a `:disabled` state. A new
  idempotent, SSR-safe `injectTheme()` adds the stylesheet to the document
  once. The shared `Authenticator`, `AccountMenuBar`, and
  `AuthenticatedContent` now render against these token classes instead
  of inline styles and inject the theme themselves, so the themed look
  travels with the component into any host (lit-html, vanilla, React,
  Next.js) with zero wiring. Every `data-testid` is preserved.
- `@aws-blocks/blocks` re-exports `injectTheme`, `THEME_CSS`, and
  `THEME_STYLE_ID` from `@aws-blocks/blocks/ui`, and adds a lean
  `@aws-blocks/blocks/theme` subpath that re-exports ONLY the token layer
  (no `Authenticator`/WebAuthn surface) for non-auth hosts. `@aws-blocks/auth-common`
  is marked `sideEffects: false` so a bundler can drop the unused UI
  surface; `@aws-blocks/blocks` is not, because as an aggregator that
  re-exports side-effecting building blocks it is not side-effect-free.
- `@aws-blocks/create-blocks-app` templates (`default`, `react`,
  `nextjs`, `demo`, `auth-cognito`) adopt the tokens for their own page
  chrome and todo UI, so the whole page is themed and dark-mode-aware;
  the `bare` template stays deliberately minimal. The static templates
  inline the first-paint palette and the `nextjs` template server-renders
  the token `<style>` so a dark-mode user never sees a white flash before
  the bundle runs. A `--bb-color-success` token keeps success messages
  from reading as accent blue.

Focus states use a real `outline` ring (preserved under forced-colors /
Windows high-contrast mode) rather than an `outline: none` + `box-shadow`
ring, which such modes drop.

Additive and non-breaking.
