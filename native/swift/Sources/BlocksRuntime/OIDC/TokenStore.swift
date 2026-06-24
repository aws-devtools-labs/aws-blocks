//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Persists OIDC tokens (access, refresh, expires_at, PKCE state).
public protocol TokenStore: Sendable {
    func get(_ key: String) async -> String?
    func set(_ key: String, value: String) async
    func delete(_ key: String) async
}

/// In-memory token store. Tokens are lost when the process exits.
public actor InMemoryTokenStore: TokenStore {
    private var storage: [String: String] = [:]

    public init() {}

    public func get(_ key: String) async -> String? {
        storage[key]
    }

    public func set(_ key: String, value: String) async {
        storage[key] = value
    }

    public func delete(_ key: String) async {
        storage.removeValue(forKey: key)
    }
}
