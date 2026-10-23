---
"aws-blocks-swift": minor
---

Fix generated Swift clients for spec names that collide with generated code or can't be Swift identifiers, and for optional arguments left out before a set one

**An optional argument left out before a set one moved the later arguments into its place.** JSON-RPC params are positional, but the generated method appended only the optional arguments that were set, so `echoArgs(first: "a", middle: nil, last: "c")` sent `["a","c"]`, and the server received `middle = "c"` and no `last`. Each argument now keeps its position, as the TypeScript client sends it: a left-out optional argument before a set one is sent as `null` (`["a",null,"c"]`), and trailing ones that aren't set are still left off. Methods with at most one optional argument after the required ones send exactly what they did.

Several names from an API's spec made the generated Swift client fail to compile:

- **A parameter named `client`** didn't compile (`value of type 'String' has no member 'execute'`): it hid the API class's own client. The method body now reads `self.client`. Parameters named `request`, `result`, `_params` or `descriptor` were shadowed by generated locals of those names (this compiled); the locals now step aside (`request_2`, `result_2`), as in the Kotlin client. A parameter named `self`, or named like a type the method body uses (`JSONDecoder`, `String`, or the method's result type, such as `profile(Profile:)` returning `Profile`), keeps its argument label and takes an internal name (`JSONDecoder JSONDecoder_2: String`). Call sites are unchanged.
- **An open record with a property named `attributes`** declared `attributes` twice. The property keeps its name, and the extra keys are in `attributes_2` (`Bag(attributes: "a", attributes_2: ["extra": "e"])`). A hybrid arm's nested union likewise moves to `challenge_2` beside a property named `challenge`.
- **A key that isn't a Swift identifier** (`back\slash`, `q"uote`) was sanitized to `back_slash`, but its JSON name was written into string literals unescaped (`invalid escape sequence in literal`). Wire names, method names, enum raw values, server names and URLs, discriminator values and validation messages are now escaped, so `back_slash` encodes and decodes as `"back\slash"`. A sanitized discriminator key keeps its JSON name too.
- **Two names that sanitize alike** in one scope (properties `a.b` and `a_b`, enum values `inProgress` and `in-progress`, methods `b.ping` and `b_ping`, two servers) were declared twice. The name that's already an identifier keeps it, and the other gets a numeric suffix (`a_b_2`, `inProgress_2`, `b_ping_2()`), keeping its JSON name.
- An enum value or union variant named after a Swift keyword (`default`, `self`) is now written in backticks (`` case `default` ``), and a variant that would be a type named `Self` or `Any` is prefixed with its discriminator (`KindSelf`).
- An operation named `client` keeps its method, and the class's client property is `client_2`. An operation's nested types are declared in an enum named after it; that enum now steps aside for a type the API class uses (an operation `item` beside a schema `Item` gets `Item_2.Result`, an operation `string` gets `String_2.Result`). A namespace whose class would be named like a schema type or `Servers` gets `_2` (`Api_2`, `Servers_2`).

Every name that didn't collide is unchanged.
