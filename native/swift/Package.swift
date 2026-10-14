// swift-tools-version: 6.2

import PackageDescription

// The build plugin's output compiles under Swift 6 rules, and any warning in it fails the build.
let generatedCodeSettings: [SwiftSetting] = [.swiftLanguageMode(.v6), .treatAllWarnings(as: .error)]

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
        // Compiles the build plugin's output for blocks.spec.json.
        .testTarget(
            name: "BlocksGeneratedCodeTests",
            dependencies: ["BlocksRuntime"],
            path: "Tests/BlocksGeneratedCodeTests",
            swiftSettings: generatedCodeSettings,
            plugins: ["BlocksCodegenBuildPlugin"]
        ),
        // The same output under Xcode 26 app defaults: MainActor default isolation and approachable concurrency.
        .testTarget(
            name: "BlocksGeneratedMainActorTests",
            dependencies: ["BlocksRuntime"],
            path: "Tests/BlocksGeneratedMainActorTests",
            swiftSettings: generatedCodeSettings + [
                .defaultIsolation(MainActor.self),
                .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
                .enableUpcomingFeature("InferIsolatedConformances")
            ],
            plugins: ["BlocksCodegenBuildPlugin"]
        ),
    ],
    // The runtime and codegen build in Swift 5 mode until the runtime is migrated.
    swiftLanguageModes: [.v5]
)
