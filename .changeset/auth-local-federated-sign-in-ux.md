---
"@aws-blocks/bb-auth": minor
"@aws-blocks/auth-common": minor
"@aws-blocks/blocks": minor
---

feat(bb-auth): show local social and SAML sign-in as unavailable instead of failing on click

In `npm run dev`, Cognito managed login does not exist, so social, SAML and `federateVia: 'cognito'` providers cannot sign anyone in. `getAuthState()` now marks their `signIn:<id>` actions with a new optional `AuthAction.unavailable` reason — for example "Google sign-in works after deploy (npm run sandbox), or use stubIdp() locally." — and the `Authenticator` renders those buttons disabled, with the reason as a hint. A browser that navigates to the sign-in route anyway gets an explanatory HTML page instead of raw JSON. API clients still get the same `501` JSON error, named `ProviderMisconfiguredException` as before; its message now says the configuration is fine and the provider works after deploy.
