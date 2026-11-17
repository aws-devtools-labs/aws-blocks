//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// The golden of a fixture whose spec the generator refuses: the `CodegenError` message.
private let codegenErrorGolden = "codegen-error.txt"

final class GoldenFileTests: XCTestCase {

    private var fixturesURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("codegen-fixtures")
    }

    private var shouldRegenerate: Bool {
        ProcessInfo.processInfo.environment["REGENERATE_FIXTURES"] == "1"
    }

    func testAllFixtures() throws {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: fixturesURL.path) else {
            XCTFail("codegen-fixtures directory not found at \(fixturesURL.path)")
            return
        }

        let fixtures = try fileManager.contentsOfDirectory(at: fixturesURL, includingPropertiesForKeys: [.isDirectoryKey])
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }

        for fixture in fixtures {
            let specURL = fixture.appendingPathComponent("spec.json")
            guard fileManager.fileExists(atPath: specURL.path) else { continue }

            let goldenDir = fixture.appendingPathComponent("swift")
            let specData = try Data(contentsOf: specURL)
            let rpcModel = try OpenRPCParser().parse(data: specData)
            let codegenModel = CodegenModelBuilder().build(from: rpcModel)
            let errorGoldenURL = goldenDir.appendingPathComponent(codegenErrorGolden)
            let output: GeneratedSources
            do {
                output = try SwiftCodeGenerator().generate(from: codegenModel)
            } catch let error as CodegenError {
                // A spec the generator refuses (a transferable parameter): the golden is the error.
                if shouldRegenerate {
                    try fileManager.createDirectory(at: goldenDir, withIntermediateDirectories: true)
                    for file in try fileManager.contentsOfDirectory(at: goldenDir, includingPropertiesForKeys: nil) {
                        try fileManager.removeItem(at: file)
                    }
                    try "\(error)\n".write(to: errorGoldenURL, atomically: true, encoding: .utf8)
                    print("  ✓ regenerated \(fixture.lastPathComponent): codegen error")
                } else {
                    guard fileManager.fileExists(atPath: errorGoldenURL.path) else {
                        XCTFail("\(fixture.lastPathComponent) failed to generate: \(error)\n"
                            + "Run: REGENERATE_FIXTURES=1 swift test --filter GoldenFileTests")
                        continue
                    }
                    let expectedError = try String(contentsOf: errorGoldenURL, encoding: .utf8)
                    XCTAssertEqual("\(error)\n", expectedError, "codegen error mismatch in \(fixture.lastPathComponent)")
                }
                continue
            }

            if shouldRegenerate {
                if fileManager.fileExists(atPath: errorGoldenURL.path) {
                    try fileManager.removeItem(at: errorGoldenURL)
                }
                try fileManager.createDirectory(at: goldenDir, withIntermediateDirectories: true)
                try output.models.write(to: goldenDir.appendingPathComponent("Models.swift"), atomically: true, encoding: .utf8)
                try output.api.write(to: goldenDir.appendingPathComponent("Api.swift"), atomically: true, encoding: .utf8)
                print("  ✓ regenerated \(fixture.lastPathComponent)")
            } else {
                guard fileManager.fileExists(atPath: goldenDir.path) else {
                    XCTFail("No golden files for \(fixture.lastPathComponent). Run: REGENERATE_FIXTURES=1 swift test --filter GoldenFileTests")
                    continue
                }

                XCTAssertFalse(fileManager.fileExists(atPath: errorGoldenURL.path),
                    "\(fixture.lastPathComponent) generates, but its golden is a codegen error")

                let modelsGoldenURL = goldenDir.appendingPathComponent("Models.swift")
                let apiGoldenURL = goldenDir.appendingPathComponent("Api.swift")

                guard fileManager.fileExists(atPath: modelsGoldenURL.path),
                      fileManager.fileExists(atPath: apiGoldenURL.path) else {
                    XCTFail("Golden files incomplete for \(fixture.lastPathComponent). Run: REGENERATE_FIXTURES=1 swift test --filter GoldenFileTests")
                    continue
                }

                let expectedModels = try String(contentsOf: modelsGoldenURL, encoding: .utf8)
                let expectedApi = try String(contentsOf: apiGoldenURL, encoding: .utf8)

                XCTAssertEqual(output.models, expectedModels,
                    "Models.swift mismatch in \(fixture.lastPathComponent)")
                XCTAssertEqual(output.api, expectedApi,
                    "Api.swift mismatch in \(fixture.lastPathComponent)")
            }
        }
    }

    /// Swift and Kotlin refuse the same fixtures, with the same message: a fixture with a Kotlin golden has a
    /// Swift `codegen-error.txt` exactly when it has a Kotlin one, and the two files are identical.
    func testSwiftAndKotlinRefuseTheSameFixturesAlike() throws {
        let fileManager = FileManager.default
        let fixtures = try fileManager.contentsOfDirectory(at: fixturesURL, includingPropertiesForKeys: nil)
            .filter { fileManager.fileExists(atPath: $0.appendingPathComponent("kotlin").path) }
        XCTAssertFalse(fixtures.isEmpty, "no fixture has a Kotlin golden under \(fixturesURL.path)")
        for fixture in fixtures {
            let golden = { (language: String) in
                try? String(contentsOf: fixture.appendingPathComponent("\(language)/\(codegenErrorGolden)"), encoding: .utf8)
            }
            XCTAssertEqual(golden("swift"), golden("kotlin"), "Swift and Kotlin codegen errors differ in \(fixture.lastPathComponent)")
        }
    }
}
