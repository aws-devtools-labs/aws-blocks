//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation
import os
import Security

private let logger = Logger(subsystem: "com.aws.blocks.swift", category: "KeychainCookieStore")

/// Persists cookies in the iOS/macOS Keychain so auth sessions survive app restarts.
///
/// Each cookie is stored as a separate Keychain item keyed by `host|cookieName`.
///
/// Uses `kSecUseDataProtectionKeychain` on macOS to opt into the iOS-style
/// data-protection keychain, which is required for sandboxed/entitled apps.
final class KeychainCookieStore {
    private let service: String

    init(service: String = "com.aws.blocks.swift.cookies") {
        self.service = service
    }

    // MARK: - Public API

    /// Returns all stored cookies as a dictionary.
    func loadAll() -> [String: String] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll
        ]
        #if os(macOS)
        query[kSecUseDataProtectionKeychain as String] = true
        #endif

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess, let items = result as? [[String: Any]] else {
            return [:]
        }

        var cookies: [String: String] = [:]
        for item in items {
            guard let account = item[kSecAttrAccount as String] as? String,
                  let data = item[kSecValueData as String] as? Data,
                  let value = String(data: data, encoding: .utf8) else {
                continue
            }
            cookies[account] = value
        }
        return cookies
    }

    /// Sets a cookie value.
    func set(name: String, value: String) {
        guard let data = value.data(using: .utf8) else { return }

        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: name
        ]
        #if os(macOS)
        query[kSecUseDataProtectionKeychain as String] = true
        #endif

        let attrs = Self.writeAttributes(data: data)

        // The update carries the accessibility class too, so an item stored by an earlier version
        // under a different class is moved to the current one in place, without losing its value.
        let status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else {
            logger.error("Updating cookie '\(name, privacy: .public)' in the keychain failed: OSStatus \(status)")
            return
        }

        var addQuery = query
        addQuery.merge(attrs) { _, new in new }
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        if addStatus != errSecSuccess {
            logger.error("Adding cookie '\(name, privacy: .public)' to the keychain failed: OSStatus \(addStatus)")
        }
    }

    /// Attributes written on every add and update of a cookie item.
    ///
    /// Items are readable only while the device is unlocked and are bound to this device, so they
    /// are not restored onto another device.
    static func writeAttributes(data: Data) -> [String: Any] {
        [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
    }

    /// Removes a cookie by name.
    func remove(name: String) {
        delete(name: name)
    }

    /// Removes all cookies.
    func removeAll() {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service
        ]
        #if os(macOS)
        query[kSecUseDataProtectionKeychain as String] = true
        #endif
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - Private

    private func delete(name: String) {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: name
        ]
        #if os(macOS)
        query[kSecUseDataProtectionKeychain as String] = true
        #endif
        SecItemDelete(query as CFDictionary)
    }
}
