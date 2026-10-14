// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "aws-blocks-swift",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(
            name: "BlocksRuntime",
            targets: ["BlocksRuntime"]
        ),
        .plugin(
            name: "BlocksCodegenCommandPlugin",
            targets: ["BlocksCodegenCommandPlugin"]
        ),
        .plugin(
            name: "BlocksCodegenBuildPlugin",
            targets: ["BlocksCodegenBuildPlugin"]
        ),
    ],
    targets: [
        .target(
            name: "BlocksRuntime",
            path: "Sources/BlocksRuntime"
        ),
        .target(
            name: "BlocksCodegen",
            path: "Sources/BlocksCodegen"
        ),
        .executableTarget(
            name: "swift-code-generator",
            dependencies: ["BlocksCodegen"],
            path: "Sources/swift-code-generator"
        ),
        .plugin(
            name: "BlocksCodegenCommandPlugin",
            capability: .command(
                intent: .custom(verb: "generate-code-from-blocks-spec", description: "Generate Swift code from Blocks spec."),
                permissions: [.writeToPackageDirectory(reason: "Writes generated Models.swift and API.swift into the target source directory")]
            ),
            dependencies: ["swift-code-generator"],
            path: "Plugins/BlocksCodegenCommandPlugin"
        ),
        .plugin(
            name: "BlocksCodegenBuildPlugin",
            capability: .buildTool(),
            dependencies: ["swift-code-generator"],
            path: "Plugins/BlocksCodegenBuildPlugin"
        ),
        .testTarget(
            name: "BlocksCodegenTests",
            dependencies: ["BlocksCodegen"],
            path: "Tests/BlocksCodegenTests"
        ),
        .testTarget(
            name: "BlocksRuntimeTests",
            dependencies: ["BlocksRuntime"],
            path: "Tests/BlocksRuntimeTests"
        ),
        // Compiles the build plugin's output for blocks.spec.json; concurrency warnings fail the build.
        .testTarget(
            name: "BlocksGeneratedCodeTests",
            dependencies: ["BlocksRuntime"],
            path: "Tests/BlocksGeneratedCodeTests",
            swiftSettings: [.enableExperimentalFeature("StrictConcurrency"), .unsafeFlags(["-warnings-as-errors"])],
            plugins: ["BlocksCodegenBuildPlugin"]
        ),
    ]
)
