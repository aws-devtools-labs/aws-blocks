---
"aws-blocks-kotlin": minor
---

Fix generated clients for spec names that collide with each other or with generated code

Several names from an API's spec made the generated Kotlin client fail to compile, fail to generate, or read the wrong JSON:

- **A parameter named `client`** didn't compile: it hid the API class's own client. Parameters named `request`, `result`, `json` or `args` hid the generated locals of the same names (a warning, or with `args` beside another optional parameter, an error). A parameter named after a Kotlin keyword (`class`, `in`) didn't compile either. Your parameter names are unchanged; the generated code now steps aside (`this.client`, `result_2`, an aliased import when a parameter is named `BlocksJson`).
- **Two properties of one schema whose names differ only in their separators** (`user_name` and `userName`, each an inline object) silently shared the first one's nested type, so the second decoded the wrong fields. Each now gets its own type (`UserName`, `UserName_2`). The same allocation fixes an enum and an object of one name in a schema, a nested type named like a property of its class (`Meta: Meta_2`), enum values and discriminator values that PascalCase alike (`in-progress`, `in_progress`), and server or namespace names that do. The JSON names are unchanged (`@SerialName`).
- **A key with a backslash, or a method of a dotted namespace** (`a.b.ping`), made code generation throw ("Can't escape identifier"). A name Kotlin can't declare even in backticks is now written as its words in camelCase (`back\slash` is `backSlash` with `@SerialName("back\\slash")`; `a.b.ping` is `A.bPing()`, which still calls `a.b.ping`).
- **Two methods whose results have the same name in the spec** (or no name at all) shared the first method's result type, and the second didn't compile. Each method now declares its own `Result`.
- An open record with a property named `attributes` keeps that property, and its extra keys are in `attributes_2`.
- A namespace whose API class would share its name with a schema type or a generated file (`api` beside a schema `Api`, or a namespace `types` or `servers`) gets `_2` (`Api_2`), and a schema named `Servers` is `Servers_2`, beside the generated `Servers` object. These clients didn't compile before.
- A validation message that quotes a pattern with a backslash or a quote (`^\d+$`) no longer breaks the generated `require`.

Every name that didn't collide is unchanged.
