---
'@aws-blocks/bb-auth': patch
---

`bb-auth migrate` leaves code alone when a name only matches a built-in `Object` member. A string literal such as `'constructor'` or `'toString'`, a call such as `auth.toString()`, and a `cognitoFederated({ identityProvider: 'constructor' })` provider are kept as written, where the codemod used to rewrite them to `undefined` or stop with `TypeError: t.join is not a function`.
