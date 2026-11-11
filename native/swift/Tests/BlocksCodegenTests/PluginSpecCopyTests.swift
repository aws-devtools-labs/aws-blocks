//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest

/// A generated-code test target compiles the build plugin's output for its own
/// `blocks.spec.json`. Where that spec is a copy of a codegen fixture's spec, the copy must stay
/// byte-for-byte equal to the fixture so the target compiles what the golden files describe.
final class PluginSpecCopyTests: XCTestCase {

    /// Test target directory under `Tests/`, paired with the codegen fixture whose spec it copies.
    private let copies: [(target: String, fixture: String)] = [
        ("BlocksGeneratedNonIdentifierNamesTests", "29-non-identifier-names"),
    ]

    private var swiftPackageURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private var fixturesURL: URL {
        swiftPackageURL
            .deletingLastPathComponent()
            .appendingPathComponent("codegen-fixtures")
    }

    func testPluginSpecCopiesMatchFixtureSpecs() throws {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: fixturesURL.path) else {
            XCTFail("codegen-fixtures directory not found at \(fixturesURL.path)")
            return
        }

        for copy in copies {
            let fixtureSpecURL = fixturesURL
                .appendingPathComponent(copy.fixture)
                .appendingPathComponent("spec.json")
            let copySpecURL = swiftPackageURL
                .appendingPathComponent("Tests")
                .appendingPathComponent(copy.target)
                .appendingPathComponent("blocks.spec.json")

            let fixtureSpec = try Data(contentsOf: fixtureSpecURL)
            let copySpec = try Data(contentsOf: copySpecURL)
            XCTAssertEqual(
                copySpec, fixtureSpec,
                "Tests/\(copy.target)/blocks.spec.json differs from codegen-fixtures/\(copy.fixture)/spec.json. "
                    + "Run: cp ../codegen-fixtures/\(copy.fixture)/spec.json Tests/\(copy.target)/blocks.spec.json"
            )
        }
    }
}
