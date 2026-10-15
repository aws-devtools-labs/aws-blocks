//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation
import BlocksCodegen

/// A sidecar file: a SwiftPM build-tool plugin cannot forward user options to a tool,
/// so the plugin passes the path of the file it already declared as a build input.
struct BlocksCodegenConfig: Decodable {
    /// Keys of `x-blocks-native-packages.packages`, not SwiftPM identities. Required,
    /// so an omitted key fails to decode; a mistyped one is caught by `knownKeys`.
    let optOutNativePackages: [String]

    enum CodingKeys: String, CodingKey, CaseIterable {
        case optOutNativePackages
    }

    static let knownKeys: Set<String> = Set(CodingKeys.allCases.map(\.rawValue))
}

let blocksCodegenConfigName = "blocks.codegen.json"

/// Resolves a trailing symlink, which `standardizingPath` alone leaves in place.
func resolvedPath(_ path: String) -> URL {
    URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
}

/// A sidecar beside the spec is never read here — the plugins pass the path — so an
/// unpassed one is refused and an overridden one is named, rather than ignored.
func reportSiblingConfig(specPath: String, configPath: String?) {
    let sibling = ((specPath as NSString).deletingLastPathComponent as NSString)
        .appendingPathComponent(blocksCodegenConfigName)
    guard FileManager.default.fileExists(atPath: sibling) else { return }
    guard let configPath else {
        fputs("Error: \(sibling) exists but was not passed; re-run with it as the third argument\n", stderr)
        exit(1)
    }
    if resolvedPath(configPath) != resolvedPath(sibling) {
        fputs("Warning: using \(configPath); \(sibling) is present but ignored\n", stderr)
    }
}

func readOptOutNativePackages(configPath: String?) -> Set<String> {
    guard let configPath else { return [] }
    guard let data = FileManager.default.contents(atPath: configPath) else {
        fputs("Error: Cannot read \(configPath)\n", stderr)
        exit(1)
    }
    do {
        // Decodable ignores unknown keys, so a mistyped one beside a correct key would
        // opt nothing out without a word.
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            fputs("Error: \(configPath) is not a JSON object\n", stderr)
            exit(1)
        }
        let unknown = Set(object.keys).subtracting(BlocksCodegenConfig.knownKeys).sorted()
        guard unknown.isEmpty else {
            fputs("Error: \(configPath) declares unknown key(s): \(unknown.joined(separator: ", "))\n", stderr)
            exit(1)
        }
        return Set(try JSONDecoder().decode(BlocksCodegenConfig.self, from: data).optOutNativePackages)
    } catch {
        fputs("Error: \(configPath) is not valid codegen configuration: \(error)\n", stderr)
        exit(1)
    }
}

@main
struct BlocksCodegenTool {
    static func main() {
        guard CommandLine.arguments.count > 1 else {
            fputs("Usage: generate-api <spec.json> [output-directory] [codegen-config.json]\n", stderr)
            exit(1)
        }

        let specPath = CommandLine.arguments[1]
        let outputDir = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "."
        let configPath = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : nil
        reportSiblingConfig(specPath: specPath, configPath: configPath)

        guard let specData = FileManager.default.contents(atPath: specPath) else {
            fputs("Error: Cannot read spec file at \(specPath)\n", stderr)
            exit(1)
        }

        // Stage 1: Parse spec → RPCModel
        let parser = OpenRPCParser(optOutNativePackages: readOptOutNativePackages(configPath: configPath))
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
        let output: GeneratedSources
        do {
            output = try generator.generate(from: codegenModel)
        } catch {
            fputs("Error: \(error)\n", stderr)
            exit(1)
        }

        // Surface non-fatal diagnostics (e.g. AWSBLOCKS-NATIVE-001) to stderr.
        for warning in output.warnings {
            fputs(warning + "\n", stderr)
        }

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
