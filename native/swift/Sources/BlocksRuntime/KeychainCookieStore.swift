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
///
/// Items are readable only while the device is unlocked, so the store also keeps the jar in
/// memory: while the Keychain cannot be read, requests are served from that copy, and a change
/// the Keychain does not accept is kept and written again on the next call.
final class KeychainCookieStore {
    private let keychain: CookieKeychain
    private let lock = NSLock()

    /// The last jar read from the Keychain with every later change applied. Served whenever the
    /// Keychain cannot be read, so a request made while the device is locked still carries the
    /// session cookies this process has seen.
    private var cache: [String: String] = [:]

    /// Changes the Keychain has not accepted yet, keyed by cookie name; a `nil` value is a
    /// removal. Each is newer than whatever the Keychain holds for that name.
    private var pending: [String: String?] = [:]

    /// Set when clearing the Keychain did not succeed, so the stored cookies are disregarded
    /// and the clear is attempted again before any pending change.
    private var clearPending = false

    convenience init(service: String = "com.aws.blocks.swift.cookies") {
        self.init(keychain: SecurityCookieKeychain(service: service))
    }

    init(keychain: CookieKeychain) {
        self.keychain = keychain
    }

    // MARK: - Public API

    /// Returns all stored cookies as a dictionary.
    func loadAll() -> [String: String] {
        lock.lock()
        defer { lock.unlock() }

        writePending()
        guard let stored = keychain.readAll() else { return cache }

        var cookies = clearPending ? [:] : stored
        for (name, value) in pending {
            cookies[name] = value
        }
        cache = cookies
        return cookies
    }

    /// Sets a cookie value.
    func set(name: String, value: String) {
        lock.lock()
        defer { lock.unlock() }

        cache[name] = value
        pending[name] = value
        writePending()
    }

    /// Removes a cookie by name.
    func remove(name: String) {
        lock.lock()
        defer { lock.unlock() }

        cache.removeValue(forKey: name)
        pending.updateValue(nil, forKey: name)
        writePending()
    }

    /// Removes all cookies.
    func removeAll() {
        lock.lock()
        defer { lock.unlock() }

        cache = [:]
        pending = [:]
        clearPending = true
        writePending()
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

    // MARK: - Private

    /// Hands every change the Keychain has not accepted yet back to it, keeping the ones it still
    /// refuses for the next call. A pending clear goes first, so it cannot remove a newer change.
    /// Must be called with `lock` held.
    private func writePending() {
        if clearPending {
            guard keychain.deleteAll() else { return }
            clearPending = false
        }
        for (name, value) in pending {
            let accepted = if let value {
                keychain.write(name: name, data: Data(value.utf8))
            } else {
                keychain.delete(name: name)
            }
            if accepted {
                pending.removeValue(forKey: name)
            }
        }
    }
}

/// The Keychain operations the cookie store relies on. Each reports whether the Keychain
/// accepted it, so the store can keep a change it refused and retry it later.
protocol CookieKeychain {
    /// Every stored cookie, or `nil` when the Keychain cannot be read right now.
    func readAll() -> [String: String]?
    /// Adds or updates one cookie item.
    func write(name: String, data: Data) -> Bool
    /// Deletes one cookie item; an item that is not there counts as deleted.
    func delete(name: String) -> Bool
    /// Deletes every cookie item; having none counts as deleted.
    func deleteAll() -> Bool
}

/// The `CookieKeychain` backed by Keychain Services.
struct SecurityCookieKeychain: CookieKeychain {
    let service: String

    func readAll() -> [String: String]? {
        var query = baseQuery()
        query[kSecReturnAttributes as String] = true
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitAll

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [:] }
        guard status == errSecSuccess, let items = result as? [[String: Any]] else {
            logger.error("Reading cookies from the keychain failed: OSStatus \(status)")
            return nil
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

    func write(name: String, data: Data) -> Bool {
        var query = baseQuery()
        query[kSecAttrAccount as String] = name

        let attrs = KeychainCookieStore.writeAttributes(data: data)

        // The update carries the accessibility class too, so an item stored by an earlier version
        // under a different class is moved to the current one in place, without losing its value.
        let status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else {
            logger.error("Updating cookie '\(name, privacy: .public)' in the keychain failed: OSStatus \(status)")
            return false
        }

        var addQuery = query
        addQuery.merge(attrs) { _, new in new }
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        if addStatus != errSecSuccess {
            logger.error("Adding cookie '\(name, privacy: .public)' to the keychain failed: OSStatus \(addStatus)")
            return false
        }
        return true
    }

    func delete(name: String) -> Bool {
        var query = baseQuery()
        query[kSecAttrAccount as String] = name
        return deleteItems(matching: query, description: "cookie '\(name)'")
    }

    func deleteAll() -> Bool {
        deleteItems(matching: baseQuery(), description: "all cookies")
    }

    private func deleteItems(matching query: [String: Any], description: String) -> Bool {
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound { return true }
        logger.error("Removing \(description, privacy: .public) from the keychain failed: OSStatus \(status)")
        return false
    }

    private func baseQuery() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service
        ]
        #if os(macOS)
        query[kSecUseDataProtectionKeychain as String] = true
        #endif
        return query
    }
}
