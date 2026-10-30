---
"@aws-blocks/core": minor
---

The OpenRPC spec generator describes a TypeScript tuple as a JSON array of positional elements, and a rest parameter typed as a tuple as one parameter per element.

**Tuples.** A tuple such as `[number, number]`, like `DistributedTable`'s `where.between`, used to be described as an object with the properties `"0"`, `"1"`, `length` and every array method. The generator now uses JSON Schema's `prefixItems`:

- **A fixed tuple** (`[A, B]`, `readonly [start: T, end: T]`) is `{ type: 'array', prefixItems: [A, B], minItems: 2, maxItems: 2 }`; `maxItems` closes it. An optional element (`[string, number?]`) counts in `maxItems` only and is nullable (`T | null`), as an optional property is. A named element type is a component, as it is anywhere else.
- **A tuple with a rest element** (`[string, ...number[]]`) has no fixed shape. It is an array of the union of its element types, with `minItems` for its required elements.
- **The empty tuple** (`[]`) is an array with `maxItems: 0`.

Native clients generated for an app whose API uses tuples change:

- **Swift and Kotlin:** the old output didn't compile. The value is now a type with properties `item0`, `item1`, and so on, which reads and writes the JSON array when the generators of this release produce it.
- **Breaking for Dart clients:** tuple-typed params and results were `dynamic` (a `List`) and are now records, e.g. `(num, String)`; one-element tuples are `List<T>`. Update call sites.

**Rest parameters typed as tuples.** The server calls a method with its params spread (`method(...params)`). A method such as `async tablePut(...args: Parameters<typeof table.put>)`, or one declared `(...args: [label: string, count?: number])`, used to be described as one parameter holding the tuple. A native client then sent `[["x", 2]]`, and the method received `args = [["x", 2]]`.

Each tuple element is now a parameter of its own. It is named by its tuple label (`item`, `options`; `Parameters<typeof f>` keeps `f`'s parameter names), otherwise `arg0`, `arg1`, and so on. It is optional where the element is. A native client sends `["x", 2]`, and the method receives `args = ["x", 2]`. A rest element inside the tuple (`[level: string, ...messages: string[]]`) takes a variable number of arguments, which positional parameters can't describe. The parameters stop before it, and spec generation prints a warning naming the method. A rest parameter typed as a plain array (`...ids: string[]`) is still one array parameter. Spec generation now warns, naming the method: a native client sends the arguments as one nested array, so the method receives that array as its only argument. An element named like an earlier parameter of the method is renamed (`id_2`).

Native clients generated for such a method take its elements as their own arguments: `tablePut(item, options)`, not `tablePut(args)`. That changes the source for code that called the old signature, which never reached the method with the right arguments.

Specs without tuples are unchanged.
