---
"@aws-blocks/blocks": minor
---

Re-export `submitAuthAction` from the umbrella `@aws-blocks/blocks/ui` entry point, alongside the existing `Authenticator`, `AuthenticatedContent`, `AccountMenuBar`, `onAuthChange`, and `broadcastAuthChange` exports. Consumers building a custom auth UI on `@aws-blocks/blocks` can now import the helper that pairs `setAuthState` with the local auth notification — so `onAuthChange` subscribers and `AuthenticatedContent` re-render on a real signed-in/signed-out transition — without reaching into `@aws-blocks/auth-common` directly. Relates to #185; addresses #208 review feedback.
