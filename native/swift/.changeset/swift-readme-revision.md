---
"aws-blocks-swift": patch
---

docs(swift): document `Blocks(server:session:tokenStore:)` as a table and regroup the generated-type rules by topic

Corrections:

- The README said the backend writes the `x-blocks-type-name` hint for a TypeScript type alias, and tied the shared `AuthActionInput` to a pull request and "an older backend". It now states what the generator does: with the hint in the spec the input of `setAuthState` is the shared `AuthActionInput`, without it `AuthApi.SetAuthState.Input`.
- The list of reasons a parameter keeps its own nested `Input` with a `swift:` warning gains the third one: a name that isn't a Swift identifier.
- The README said passkey actions need WebAuthn APIs "the runtime doesn't call yet". It now says the runtime does not run WebAuthn.
- The demo README told a reader with a physical device to deploy and "regenerate". It now names the command: `BLOCKS_SPEC_STAGE=production npm run spec` in place of step 2.
- The demo README's folder tree omitted files the demo has. It is now two lines that name the two folders and what each holds.
- The demo backend README's "Commands" omitted `npm run spec`, which the demo's step 2 runs.
- The demo README's step 1 did not say that `npm install` fetches a published `@aws-blocks/blocks` without the `Auth` block the backend imports. It now says so, and how to run the backend against the packages of an AWS Blocks checkout until a release includes `Auth`.
- The demo README listed `swift package generate-code-from-blocks-spec` as a way to generate the demo's code. From `native/swift/` that command generates into the package's own test targets; the README now says so and keeps the Xcode form, which reads `swift-demo/blocks.spec.json`.

Added:

- README, "Configuration": a table of the parameters of `Blocks(server:session:tokenStore:)` with defaults, including the default `InMemoryTokenStore()`, followed by "Lifetime" and "Code generation". The quick start keeps one sentence and a link.
- README, "OIDC sign-in": a table of the launcher options (`presentationAnchor`, `prefersEphemeralWebBrowserSession`) and a table of the errors `signIn` throws: the eight `OIDCError` cases and `CancellationError`.

Restructured:

- README: "Features" is now "Generated types", with the sections "Models and initializers", "Dates", "Unions and literals", "One input type for every Auth block", "Open records", "Names" and "Transferables". Typed OIDC providers are described once, under "OIDC sign-in".
- Demo README: step 4 keeps the CLI command the demo uses, names the two generated files the demo target compiles, and lists the Xcode command plugin and the build plugin as two items with what each needs. The note about a stack whose todos table is keyed on `userId` is one line after step 5.

Removed:

- README: comparisons with the Dart and Kotlin SDKs, statements about what earlier releases returned, and the pointer to the `Auth` block README's "Native apps" section.
- Demo README: the `Package.swift` snippet for the build plugin, which the README's quick start has.
- Demo backend README: the "For Coding Agents", "Documentation Location" and "For Humans" sections; the `npm run docs` pointer appears once.

No behavior changes.
