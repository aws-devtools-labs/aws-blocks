//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

/// The version constant is generated and committed, so the compiler checks nothing.
/// These tests guard the token format and the version constant.
final class BlocksVersionTests: XCTestCase {

    /// The token format this library commits to: `aws-blocks-<lang>/<semver>` —
    /// a bounded lowercase-alphanumeric language segment plus a strict semver.
    private let grammar = #"^aws-blocks-([a-z][a-z0-9]{0,15})/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]{1,20})?)$"#

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
        let regex = try NSRegularExpression(pattern: #"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]{1,20})?$"#)
        let range = NSRange(blocksRuntimeVersion.startIndex..., in: blocksRuntimeVersion)

        XCTAssertNotNil(
            regex.firstMatch(in: blocksRuntimeVersion, range: range),
            "\(blocksRuntimeVersion) is not valid semver"
        )
    }

    /// Guards against the generator emitting the `0.0.0` placeholder.
    func testRuntimeVersionIsNotAPlaceholder() {
        XCTAssertNotEqual(blocksRuntimeVersion, "0.0.0")
    }
}
