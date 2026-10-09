---
"aws-blocks-swift": minor
---

Generated Swift clients compile when two properties would declare the same nested type

The generator names an inline type after its property, and singularizes an array's element type. So `item: { … }` and `items: { … }[]` both declared a type named `Item`, and a `feed` channel next to a `feeds` list of channels both declared `FeedMessage`. The type was declared twice and the generated client didn't compile (`invalid redeclaration of 'Item'`). This happened in your named types, in an operation's parameters and result, and in a union's variants.

Each name is now declared once. The property whose own type it is keeps the name. The other type takes its property's name without singularizing it: `items: [Items]`, `feeds: [RealtimeChannel<FeedsMessage>]`. If that's taken too, it gets a numeric suffix. For example, `tags: Record<string, { … }>` next to `tagsValue: { … }` gives `tags: [String: TagsValue_2]`, and a parameter named `result` next to an inline result gives `check(result: Check.Result_2) -> Check.Result`.

An enum or union declared directly on one of your named types is generated at the top level of `Models.swift`, and there a second one with the same name used to be silently replaced by the first. For example, if `Order` and `Ticket` each had a `status` enum with different values, `Ticket.status` was typed as `Order`'s enum, so a ticket's status didn't decode. An inline type could also take the name of one of your named types, which was then missing from the client. Identical types still share one declaration. A different one is now prefixed with its type's name (`Ticket.status` becomes `TicketStatus`), and your named types always keep their names.

An operation whose parameter and result each declared a type with the same name typed the parameter with the result's type: `setStatus(status:)` returning `{ status, … }` took a `SetStatus.Result.Status`. It now takes its own type, `SetStatus.Status`. Code that passes `.active` still compiles. Code that names the old type explicitly needs updating.

A union with a case that has no payload no longer produces two compiler warnings (`variable 'c' was never mutated` and `variable 'lastError' was written to, but never read`).

Every other generated name is unchanged.
