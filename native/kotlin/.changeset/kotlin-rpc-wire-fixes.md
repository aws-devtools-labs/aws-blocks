---
"aws-blocks-kotlin": minor
---

Fix optional arguments, dotless method names and union variant payload types in generated clients

- **Leaving out an optional argument no longer moves the next one into its place.** The server reads JSON-RPC params by position, but a generated method sent only the optional arguments you set, after all the required ones. With `send(a: String, b: String? = null, c: String? = null)`, `send("a", c = "c")` sent `["a","c"]`, which the server read as `b = "c"`; and a required parameter after an optional one was sent before it. Every argument now keeps its slot, as the TypeScript client sends it: `send("a", c = "c")` sends `["a",null,"c"]`. Optional arguments at the end that you leave out are still not sent, so `send("a")` sends `["a"]`. Methods whose only optional parameter is the last one are unchanged.
- **A method with no dot in its name is sent by that name.** A hand-written spec's `ping` (grouped into the `Default` class) was sent as `_default.ping`, a method the spec doesn't have; it is now sent as `ping`, as the Swift and Dart clients do. Specs generated from an AWS Blocks backend always name methods `<namespace>.<method>`, so their clients are unchanged.
- **Union variants whose same-named properties have different shapes get their own types.** In a component schema, a union whose variants each have an inline-object `payload` (or an inline enum of one name) with different fields gave every variant the first variant's type, so the others decoded the wrong fields or failed. A variant whose type differs now gets its own (`Payload_2`, `Status_2`); variants whose types match still share one, and every other generated name is unchanged.
