---
"aws-blocks-swift": patch
---

`unknown`-typed fields now generate as `JSONValue` and keep their value

A value the API types as `unknown` (for example `Record<string, unknown>`, such as the `claims` on an `AuthenticatedUser` your API returns) used to generate as an empty struct, which dropped the value and failed to decode anything but a JSON object. It now generates as `JSONValue` — `[String: JSONValue]` for a map, `[JSONValue]` for a list — which holds any JSON value.
