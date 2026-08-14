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
            file.path.lastComponent == "blocks.spec.json"
        }

        guard let specFile else {
            return []
        }

        let generatorTool = try context.tool(named: "swift-code-generator")
        let outputDir = context.pluginWorkDirectory.appending("Generated")

        let modelsOutput = outputDir.appending("Models.swift")
        let apiOutput = outputDir.appending("API.swift")

        return [
            .buildCommand(
                displayName: "Generate Blocks API from \(specFile.path.lastComponent)",
                executable: generatorTool.path,
                arguments: [specFile.path.string, outputDir.string],
                inputFiles: [specFile.path],
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
            file.path.lastComponent == "blocks.spec.json"
        }

        guard let specFile else {
            return []
        }

        let generatorTool = try context.tool(named: "swift-code-generator")
        let outputDir = context.pluginWorkDirectory.appending("Generated")

        let modelsOutput = outputDir.appending("Models.swift")
        let apiOutput = outputDir.appending("API.swift")

        return [
            .buildCommand(
                displayName: "Generate Blocks API from \(specFile.path.lastComponent)",
                executable: generatorTool.path,
                arguments: [specFile.path.string, outputDir.string],
                inputFiles: [specFile.path],
                outputFiles: [modelsOutput, apiOutput]
            )
        ]
    }
}
#endif
