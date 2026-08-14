//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import PackagePlugin
import Foundation

/// A command plugin that generates typed Swift models and API methods
/// from an OpenRPC spec file (`blocks.spec.json`).
///
/// Run via: right-click package in Xcode → "generate-api"
/// Or CLI: swift package generate-api --target MyTarget
///
/// The plugin finds `blocks.spec.json` in the target's source directory
/// and writes `Models.swift` and `API.swift` next to it (in a `Generated/` subfolder).
@main
struct BlocksCodegenCommandPlugin: CommandPlugin {
    func performCommand(context: PluginContext, arguments: [String]) async throws {
        // Parse arguments to find target name
        var argExtractor = ArgumentExtractor(arguments)
        let targetNames = argExtractor.extractOption(named: "target")

        let targets: [Target]
        if targetNames.isEmpty {
            // Default: process all source targets
            targets = context.package.targets.filter { $0 is SourceModuleTarget }
        } else {
            targets = try targetNames.map { name in
                guard let target = context.package.targets.first(where: { $0.name == name }) else {
                    throw "Target '\(name)' not found"
                }
                return target
            }
        }

        let generatorTool = try context.tool(named: "swift-code-generator")

        for target in targets {
            guard let sourceTarget = target as? SourceModuleTarget else { continue }

            // Find blocks.spec.json in the target's source files
            let specFile = sourceTarget.sourceFiles.first { file in
                file.path.lastComponent == "blocks.spec.json"
            }

            guard let specFile else {
                print("⚠️  No blocks.spec.json in target '\(target.name)', skipping.")
                continue
            }

            // Output to a Generated/ folder next to the spec file
            let outputDir = specFile.path.removingLastComponent().appending(subpath: "Generated")

            print("🔄 Generating API for target '\(target.name)'...")
            print("   Spec: \(specFile.path.string)")
            print("   Output: \(outputDir.string)")

            let process = Process()
            process.executableURL = URL(fileURLWithPath: generatorTool.path.string)
            process.arguments = [specFile.path.string, outputDir.string]

            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe

            try process.run()
            process.waitUntilExit()

            let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            if !output.isEmpty { print(output) }

            if process.terminationStatus != 0 {
                throw "generate-api failed with exit code \(process.terminationStatus)"
            }

            print("✅ Generated API for '\(target.name)'")
        }
    }
}

extension String: @retroactive Error {}

#if canImport(XcodeProjectPlugin)
import XcodeProjectPlugin

extension BlocksCodegenCommandPlugin: XcodeCommandPlugin {
    func performCommand(context: XcodePluginContext, arguments: [String]) throws {
        let generatorTool = try context.tool(named: "swift-code-generator")

        // Find blocks.spec.json in the project directory
        let projectDir = context.xcodeProject.directory
        let candidates = [
            projectDir.appending(subpath: "blocks.spec.json"),
            projectDir.appending(subpath: "aws-blocks/blocks.spec.json"),
        ]

        guard let specPath = candidates.first(where: { FileManager.default.fileExists(atPath: $0.string) }) else {
            print("⚠️  No blocks.spec.json found in project directory.")
            return
        }

        // Output to Generated/ folder in the project
        let outputDir = projectDir.appending(subpath: "Generated")

        print("🔄 Generating API...")
        print("   Spec: \(specPath.string)")
        print("   Output: \(outputDir.string)")

        let process = Process()
        process.executableURL = URL(fileURLWithPath: generatorTool.path.string)
        process.arguments = [specPath.string, outputDir.string]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        try process.run()
        process.waitUntilExit()

        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        if !output.isEmpty { print(output) }

        guard process.terminationStatus == 0 else {
            print("❌ generate-api failed with exit code \(process.terminationStatus)")
            return
        }

        print("✅ Generated Models.swift and API.swift in Generated/")
        print("   Add the Generated/ folder to your Xcode target if not already added.")
    }
}
#endif
