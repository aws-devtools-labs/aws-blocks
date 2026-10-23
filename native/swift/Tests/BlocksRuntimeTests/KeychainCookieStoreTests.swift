//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Security
import XCTest
@testable import BlocksRuntime

/// Validates the attributes the Keychain cookie store writes on add and update.
final class KeychainCookieStoreTests: XCTestCase {

    func testWriteAttributesUseThisDeviceOnlyAccessibility() throws {
        let attrs = KeychainCookieStore.writeAttributes(data: Data("v".utf8))

        let accessible = try XCTUnwrap(attrs[kSecAttrAccessible as String])
        XCTAssertTrue(
            CFEqual(accessible as CFTypeRef, kSecAttrAccessibleWhenUnlockedThisDeviceOnly),
            "expected kSecAttrAccessibleWhenUnlockedThisDeviceOnly, got \(accessible)"
        )
    }

    func testWriteAttributesCarryTheValue() {
        let data = Data("cookie-value".utf8)
        let attrs = KeychainCookieStore.writeAttributes(data: data)

        XCTAssertEqual(attrs[kSecValueData as String] as? Data, data)
    }
}
