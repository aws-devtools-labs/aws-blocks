---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

feat(core): read native package and binding declarations from each block's package.json

A Building Block declares its native packages and transferable bindings under an
`aws-blocks.native` key in its own `package.json`. `blocks-generate-spec` reads
that key from every `node_modules` level from the spec project upward and emits the
`x-blocks-native-packages` and `x-blocks-native-bindings` catalogs, which until
now nothing populated. Each import specifier resolves to its nearest installed copy,
as in Node's own resolution. The new `readNativeDeclarations` export supplies the
same declarations to a project that calls `writeSpec` directly instead of through
the bin.

A spec generated for an app where no block declares the key is byte-identical to
before. Generation now exits non-zero without writing a file when an installed
block's declarations are invalid, or when an installed `package.json` cannot be
parsed while naming `aws-blocks` — such a manifest cannot be ruled out as a
declarer, so it is not treated as declaring nothing. A `node_modules` directory
or a manifest that cannot be read for a reason other than absence, and an
unparseable manifest whose text never names `aws-blocks`, are warned and
skipped. A byte-order mark is accepted, as npm accepts one. A `packages` or
`bindings` set to `null` is now reported rather than read as absent.

A native declaration error raised before any block could be named now reports
the position the pass had reached.

`NativeDeclarationInput` is the same shape with `packages` and `bindings` typed
`unknown`, which is what a `package.json` yields before anything checks it.
`SpecGenerationOptions.nativeDeclarations` accepts it, and a typed
`NativeDeclarationSource` built in code still assigns and stays readable. Code
that reads `SpecGenerationOptions.nativeDeclarations` back narrows it to the
exported `NativeDeclarationSource`.

`@aws-blocks/blocks` gets the same bump because it re-exports `@aws-blocks/core/scripts`.
