---
'@aws-blocks/core': patch
---

The OpenRPC spec now records the name of a union declared as a type alias. An inline `oneOf` for `type AuthActionInput = ...` carries `"x-blocks-type-name": "AuthActionInput"`, so native code generators can name the union after the alias. The union stays inline, and generators that don't read the key are unaffected.
