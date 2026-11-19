---
"aws-blocks-swift": minor
---

The Swift package is now published from `https://github.com/aws/cdk-blocks-swift.git`, and its package name is `cdk-blocks-swift`. Update the dependency URL, and change `package: "aws-blocks-swift"` to `package: "cdk-blocks-swift"` in your `.product(...)` and `.plugin(...)` references:

```swift
.package(url: "https://github.com/aws/cdk-blocks-swift.git", .upToNextMinor(from: "0.2.0")),
// ...
.product(name: "BlocksRuntime", package: "cdk-blocks-swift"),
.plugin(name: "BlocksCodegenBuildPlugin", package: "cdk-blocks-swift"),
```

SwiftPM takes `package:` from the URL, not from the package's declared name, so change the URL and every `package:` together, in every `Package.swift` that uses the SDK. A manifest that keeps the old URL with the new `package:`, or the reverse, fails to resolve. An Xcode project only needs the new URL.

Product and module names (`BlocksRuntime`, `BlocksCodegenBuildPlugin`) are unchanged.
