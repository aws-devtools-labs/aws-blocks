---
"@aws-blocks/bb-auth": patch
"@aws-blocks/blocks": patch
---

`Auth` no longer drops a claim or attribute because of its name. A string claim named `__proto__` in an ID token now appears in the signed-in user's `attributes` like any other claim, and for a directly federated OIDC provider the userinfo response now fills in a claim the ID token left out even when it is named like a built-in object member (`__proto__`, `constructor`, `toString`). The same holds for the attributes `validateUser` receives from the Cognito pre-sign-up trigger and for user attributes and devices read from the local store under `npm run dev`. Apps need no changes.
