---
"aws-blocks-swift": major
---

The Swift package is now published from `https://github.com/aws/cdk-blocks-swift.git`, and its package name is `cdk-blocks-swift`. Update the dependency URL, and change `package: "aws-blocks-swift"` to `package: "cdk-blocks-swift"` in your `.product(...)` and `.plugin(...)` references:

```swift
.package(url: "https://github.com/aws/cdk-blocks-swift.git", from: "1.0.0"),
// ...
.product(name: "BlocksRuntime", package: "cdk-blocks-swift"),
.plugin(name: "BlocksCodegenBuildPlugin", package: "cdk-blocks-swift"),
```

Product and module names (`BlocksRuntime`, `BlocksCodegenBuildPlugin`) are unchanged.
