---
'@aws-blocks/core': patch
---

The OpenRPC spec now records the name of a union declared as a type alias. An inline `oneOf` for `type AuthActionInput = ...` carries `"x-blocks-type-name": "AuthActionInput"`, so native code generators can name the union after the alias. Only a non-generic alias is recorded: an instantiation of a generic alias (`Result<string>`, or a TypeScript utility type such as `Partial<Action>`) carries no name, so two instantiations never share one. The union stays inline, and generators that don't read the key are unaffected.
