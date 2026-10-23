//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Security
import XCTest
@testable import BlocksRuntime

/// Validates the attributes the Keychain cookie store writes on add and update, and how the store
/// behaves while the Keychain cannot be read or written, as when the device is locked.
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

    func testCookiesAreServedFromMemoryWhileTheKeychainCannotBeRead() {
        let keychain = FakeCookieKeychain()
        let store = KeychainCookieStore(keychain: keychain)
        store.set(name: "host|session", value: "abc")

        keychain.available = false

        XCTAssertEqual(store.loadAll(), ["host|session": "abc"])
    }

    func testACookieTheKeychainRefusesIsKeptAndWrittenLater() {
        let keychain = FakeCookieKeychain()
        keychain.available = false
        let store = KeychainCookieStore(keychain: keychain)

        store.set(name: "host|session", value: "abc")

        XCTAssertEqual(store.loadAll(), ["host|session": "abc"])
        XCTAssertTrue(keychain.items.isEmpty)

        keychain.available = true

        XCTAssertEqual(store.loadAll(), ["host|session": "abc"])
        XCTAssertEqual(keychain.items, ["host|session": "abc"])
    }

    func testARefusedRemovalIsNotUndoneByTheStoredCopy() {
        let keychain = FakeCookieKeychain()
        keychain.items = ["host|session": "abc"]
        let store = KeychainCookieStore(keychain: keychain)

        keychain.available = false
        store.remove(name: "host|session")
        keychain.available = true

        XCTAssertEqual(store.loadAll(), [:])
        XCTAssertTrue(keychain.items.isEmpty)
    }

    func testARefusedClearIsRetriedBeforeANewerCookie() {
        let keychain = FakeCookieKeychain()
        keychain.items = ["host|old": "1"]
        let store = KeychainCookieStore(keychain: keychain)

        keychain.available = false
        store.removeAll()
        store.set(name: "host|new", value: "2")
        keychain.available = true

        XCTAssertEqual(store.loadAll(), ["host|new": "2"])
        XCTAssertEqual(keychain.items, ["host|new": "2"])
    }
}

/// A `CookieKeychain` held in memory that refuses every operation while `available` is false,
/// as Keychain Services does for this accessibility class while the device is locked.
private final class FakeCookieKeychain: CookieKeychain {
    var available = true
    var items: [String: String] = [:]

    func readAll() -> [String: String]? {
        available ? items : nil
    }

    func write(name: String, data: Data) -> Bool {
        guard available else { return false }
        items[name] = String(data: data, encoding: .utf8)
        return true
    }

    func delete(name: String) -> Bool {
        guard available else { return false }
        items.removeValue(forKey: name)
        return true
    }

    func deleteAll() -> Bool {
        guard available else { return false }
        items = [:]
        return true
    }
}
