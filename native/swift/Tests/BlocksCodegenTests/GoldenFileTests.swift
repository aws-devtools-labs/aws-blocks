//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

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
            let output = SwiftCodeGenerator().generate(from: codegenModel)

            if shouldRegenerate {
                try fileManager.createDirectory(at: goldenDir, withIntermediateDirectories: true)
                try output.models.write(to: goldenDir.appendingPathComponent("Models.swift"), atomically: true, encoding: .utf8)
                try output.api.write(to: goldenDir.appendingPathComponent("Api.swift"), atomically: true, encoding: .utf8)
                print("  ✓ regenerated \(fixture.lastPathComponent)")
            } else {
                guard fileManager.fileExists(atPath: goldenDir.path) else {
                    XCTFail("No golden files for \(fixture.lastPathComponent). Run: REGENERATE_FIXTURES=1 swift test --filter GoldenFileTests")
                    continue
                }

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
}
