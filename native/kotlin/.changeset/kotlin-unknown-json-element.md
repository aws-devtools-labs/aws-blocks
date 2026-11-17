---
"aws-blocks-kotlin": patch
---

`unknown`-typed fields now generate as `JsonElement` and compile

A value the API types as `unknown` (for example `Record<string, unknown>`, such as the `claims` on an `AuthenticatedUser` your API returns) used to generate as `Any`, which kotlinx.serialization can't serialize, so the generated client didn't compile. It now generates as `kotlinx.serialization.json.JsonElement` — `Map<String, JsonElement>` for a map, `List<JsonElement>` for a list — and works as a property, parameter or return value.
