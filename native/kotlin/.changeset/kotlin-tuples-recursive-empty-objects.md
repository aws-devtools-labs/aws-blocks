---
"aws-blocks-kotlin": minor
---

Fix generated clients for tuples, self-referencing types, and objects with no properties

- **Tuples** (`prefixItems`, TypeScript `[number, number]`) read and write a JSON array. The generated data class keeps its `item0`, `item1`, … properties, but it used to be serialized as an object (`{"item0":1,"item1":2}`), so it couldn't decode a tuple from the server, and the server couldn't read one sent to it. The class now has a `TupleSerializer` that writes `[1, 2]` and reads it back. An element missing from a shorter array (an optional element) decodes as `null`. A tuple that is one alternative of a union is a `JsonElement`.
- **A schema that refers to itself**, directly (`TreeNode.children: [TreeNode]`, `ListItem.next: ListItem | null`) or through another schema (`Category` and `Product` that hold each other), made code generation fail with a `StackOverflowError`. Each is now one class whose properties use its own type: `List<TreeNode>`, `ListItem?`, `Map<String, TreeNode>`. A schema that isn't an object, such as a recursive union, is a `JsonElement` where it recurs.
- **An object with no properties** (`{ "type": "object" }`, `"properties": {}`, or a component schema that is one) generated `data class X()`, which doesn't compile. It is now a `Map<String, JsonElement>` that keeps every field, as an object with any fields already was. A component schema with no properties is used as that map, so no class named after it is generated.
