//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation
import BlocksCodegen

@main
struct BlocksCodegenTool {
    static func main() {
        guard CommandLine.arguments.count > 1 else {
            fputs("Usage: generate-api <spec.json> [output-directory]\n", stderr)
            exit(1)
        }

        let specPath = CommandLine.arguments[1]
        let outputDir = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "."

        guard let specData = FileManager.default.contents(atPath: specPath) else {
            fputs("Error: Cannot read spec file at \(specPath)\n", stderr)
            exit(1)
        }

        // Stage 1: Parse spec → RPCModel
        let parser = OpenRPCParser()
        let rpcModel: RPCModel
        do {
            rpcModel = try parser.parse(data: specData)
        } catch {
            fputs("Error: Failed to parse spec: \(error)\n", stderr)
            exit(1)
        }

        // Stage 2: Build intermediate model → CodegenModel
        let builder = CodegenModelBuilder()
        let codegenModel = builder.build(from: rpcModel)

        // Stage 3: Generate Swift source
        let generator = SwiftCodeGenerator()
        let output = generator.generate(from: codegenModel)

        // Write output files
        let modelsHeader = """
        //
        // Models.swift
        // Auto-generated from OpenRPC spec — do not edit.
        //

        """

        let apiHeader = """
        //
        // API.swift
        // Auto-generated from OpenRPC spec — do not edit.
        //

        """

        let modelsContent = modelsHeader + "\n" + output.models + "\n"
        let apiContent = apiHeader + "\n" + output.api + "\n"

        do {
            try FileManager.default.createDirectory(atPath: outputDir, withIntermediateDirectories: true)

            let modelsPath = (outputDir as NSString).appendingPathComponent("Models.swift")
            try modelsContent.write(toFile: modelsPath, atomically: true, encoding: String.Encoding.utf8)
            print("✓ Generated \(modelsPath)")

            let apiPath = (outputDir as NSString).appendingPathComponent("API.swift")
            try apiContent.write(toFile: apiPath, atomically: true, encoding: String.Encoding.utf8)
            print("✓ Generated \(apiPath)")
        } catch {
            fputs("Error writing output: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }
}
