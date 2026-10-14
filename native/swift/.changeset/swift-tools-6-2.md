---
"aws-blocks-swift": minor
---

chore(swift): require Swift 6.2 (Xcode 26) and generate `nonisolated` types

The package now declares `swift-tools-version: 6.2`, so building it needs Xcode 26 or a Swift 6.2
toolchain; Xcode 15 and 16 can no longer resolve it. Apps can still build in Swift 5 or Swift 6
language mode.

Every top-level generated type (`Blocks`, the namespace classes, `Servers` and the models) is now
`nonisolated`. Generated code compiles in the app's target, so under Xcode 26's default `MainActor`
isolation it was main-actor-isolated: `Blocks()` and `close()` could not be called from an actor or
a detached task, and operations hopped to the main actor. It now behaves the same with or without
that setting.
