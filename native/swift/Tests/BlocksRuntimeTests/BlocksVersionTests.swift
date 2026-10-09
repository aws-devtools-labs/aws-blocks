//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

/// Validates the generated version constant and user-agent token grammar.
final class BlocksVersionTests: XCTestCase {

    /// Token format: aws-blocks-<lang>/<version>. The language is 1-16 lowercase alphanumeric
    /// characters starting with a letter; version is numeric X.Y.Z with an optional prerelease and no build metadata.
    private let grammar = #"^aws-blocks-([a-z][a-z0-9]{0,15})/(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$"#

    func testUserAgentTokenMatchesExpectedFormat() throws {
        let regex = try NSRegularExpression(pattern: grammar)
        let range = NSRange(blocksUserAgentToken.startIndex..., in: blocksUserAgentToken)

        XCTAssertNotNil(
            regex.firstMatch(in: blocksUserAgentToken, range: range),
            "\(blocksUserAgentToken) does not match the expected aws-blocks-<lang>/<semver> format"
        )
    }

    /// Rows whose user agent does not contain `aws-blocks` do not appear in
    /// reporting, so renaming the token would lose this library's traffic.
    func testUserAgentTokenKeepsWarehousePrefix() {
        XCTAssertTrue(blocksUserAgentToken.contains("aws-blocks"))
    }

    func testUserAgentTokenEmbedsCurrentVersion() {
        XCTAssertEqual(blocksUserAgentToken, "aws-blocks-swift/\(blocksRuntimeVersion)")
    }

    func testRuntimeVersionIsSemver() throws {
        let regex = try NSRegularExpression(pattern: #"^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"#)
        let range = NSRange(blocksRuntimeVersion.startIndex..., in: blocksRuntimeVersion)

        XCTAssertNotNil(
            regex.firstMatch(in: blocksRuntimeVersion, range: range),
            "\(blocksRuntimeVersion) is not valid semver"
        )
    }

    func testRuntimeVersionIsNotAPlaceholder() {
        XCTAssertNotEqual(blocksRuntimeVersion, "0.0.0")
    }
}
