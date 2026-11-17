---
'@aws-blocks/bb-auth': patch
---

`bb-auth migrate` leaves code alone when a name only matches a built-in `Object` member. A string literal such as `'constructor'` or `'toString'`, a call such as `auth.toString()`, and a `cognitoFederated({ identityProvider: 'constructor' })` provider are kept as written.

A file that both imports and re-exports an old name, such as `import { AuthCognito } …` next to `export { AuthCognito } from '@aws-blocks/bb-auth-cognito'`, keeps the re-export: it is rewritten to `export { Auth } from '@aws-blocks/bb-auth'`.
