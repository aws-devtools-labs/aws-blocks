---
"@aws-blocks/create-blocks-app": patch
---

docs(agents): spell out the auth frontend-mount outcome and a check in the scaffolded AGENTS.md

The scaffolded `AGENTS.md` already shows the `Authenticator` + `onAuthChange`
mount, but an agent could still provision the auth backend and stop there,
leaving every gated route unreachable. Add a short, template-agnostic
outcome + available-parts + check note: state that the backend renders no UI,
name `Authenticator` and `AuthenticatedContent` as the parts to fit into
whatever frontend the task has, and give a signed-out/signed-in check. Scope
the stable testids to `AuthBasic`/`AuthCognito` and link `CUSTOMIZING-AUTH-UI.md`
for the full contract (OIDC/federated actions carry a provider suffix).

Documentation only — no runtime or API change.
