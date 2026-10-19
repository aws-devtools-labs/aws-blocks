//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import PackagePlugin
import Foundation

/// A build plugin that automatically generates typed Swift models and API methods
/// from a Blocks spec file (`blocks.spec.json`) at build time.
///
/// Add this plugin to your target and include `blocks.spec.json` in your source files.
/// The generated `Models.swift` and `API.swift` will be compiled as part of the target.
@main
struct BlocksCodegenBuildPlugin: BuildToolPlugin {
    func createBuildCommands(context: PluginContext, target: Target) async throws -> [Command] {
        guard let sourceTarget = target as? SourceModuleTarget else { return [] }

        // Find blocks.spec.json in the target's source files
        let specFile = sourceTarget.sourceFiles.first { file in
            file.url.lastPathComponent == "blocks.spec.json"
        }

        guard let specFile else {
            return []
        }

        let generatorTool = try context.tool(named: "swift-code-generator")
        let outputDir = context.pluginWorkDirectoryURL.appendingPathComponent("Generated")

        let modelsOutput = outputDir.appendingPathComponent("Models.swift")
        let apiOutput = outputDir.appendingPathComponent("API.swift")

        return [
            .buildCommand(
                displayName: "Generate Blocks API from \(specFile.url.lastPathComponent)",
                executable: generatorTool.url,
                arguments: [specFile.url.path(percentEncoded: false), outputDir.path(percentEncoded: false)],
                inputFiles: [specFile.url],
                outputFiles: [modelsOutput, apiOutput]
            )
        ]
    }
}

#if canImport(XcodeProjectPlugin)
import XcodeProjectPlugin

extension BlocksCodegenBuildPlugin: XcodeBuildToolPlugin {
    func createBuildCommands(context: XcodePluginContext, target: XcodeTarget) throws -> [Command] {
        let specFile = target.inputFiles.first { file in
            file.url.lastPathComponent == "blocks.spec.json"
        }

        guard let specFile else {
            return []
        }

        let generatorTool = try context.tool(named: "swift-code-generator")
        let outputDir = context.pluginWorkDirectoryURL.appendingPathComponent("Generated")

        let modelsOutput = outputDir.appendingPathComponent("Models.swift")
        let apiOutput = outputDir.appendingPathComponent("API.swift")

        return [
            .buildCommand(
                displayName: "Generate Blocks API from \(specFile.url.lastPathComponent)",
                executable: generatorTool.url,
                arguments: [specFile.url.path(percentEncoded: false), outputDir.path(percentEncoded: false)],
                inputFiles: [specFile.url],
                outputFiles: [modelsOutput, apiOutput]
            )
        ]
    }
}
#endif
