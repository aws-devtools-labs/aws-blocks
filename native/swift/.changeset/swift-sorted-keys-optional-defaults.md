---
"aws-blocks-swift": patch
---

Send request bodies with sorted keys, let callers leave out optional arguments with a nullable type, and fix two kinds of generated models that didn't compile

- **Request bodies are the same bytes every time.** `JSONEncoder` on Apple platforms doesn't fix the order of an object's keys, so the same call could send `{"at":…,"title":…}` once and `{"title":…,"at":…}` the next. The client's encoder (`BlocksClient.makeEncoder()`, which every request uses) and the raw auth routes now sort keys. The server reads both orders the same way; this matters to anything that compares, caches or signs a request body.
- **An optional argument can be left out even when its type is nullable.** A TypeScript `echoArgs(first: string, middle?: string, last?: string)` generated `echoArgs(first: String, middle: String?, last: String?)`, with no default for `middle` and `last`, so every call had to pass `nil` for them. Optional parameters now default to `nil`: `echoArgs(first: "a", last: "c")`. Calls that pass `nil` still compile and send the same request.
- **A schema with a constraint (`minLength`, `pattern`, `minimum`, …) in `components` didn't compile** when the generated code is its own module: its init throws `CodegenError`, but `Models.swift` didn't import `BlocksRuntime` (`cannot find 'CodegenError' in scope`). `Models.swift` now imports `BlocksRuntime` whenever it uses a type from it.
- **A string `default` or a `pattern` with special characters didn't compile.** A default was written in its JSON spelling (`"a\/b"`, `"\u0001"`), which isn't valid Swift, and a line break in a `pattern` ended the string literal. Both are now escaped like every other spec string in generated code, so a default like `a/b \(1+1)` is exactly that string, never an interpolation.
