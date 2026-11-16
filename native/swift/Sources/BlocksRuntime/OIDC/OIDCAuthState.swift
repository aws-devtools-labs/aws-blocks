//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Authentication state emitted by `OIDCClient.authStateChanges`.
public enum OIDCAuthState: Sendable, Equatable {
    case loading
    case signedOut
    case signedIn(OIDCUser)
}

/// The authenticated user surfaced after token exchange.
///
/// The values are for display only. After `exchange` they are what the server's exchange response
/// reports; after `restore()` they are decoded on the device from the stored access token's payload
/// (`sub`, `username`, `groups`) without verifying its signature. Neither is verified by this client,
/// so do not use them to decide what the user may see or do. Make authorization decisions on the server, which verifies the token sent with each request.
public struct OIDCUser: Sendable, Equatable, Codable {
    /// The user's identifier (the token's `sub` claim). For display only; not verified on the device.
    public let userId: String
    /// The user's name (the token's `username` claim). For display only; not verified on the device.
    public let username: String
    /// The groups the token lists (its `groups` claim). For display only, such as choosing which
    /// screens to offer; not verified on the device, so the server must enforce group membership.
    public let groups: [String]

    public init(userId: String, username: String, groups: [String]) {
        self.userId = userId
        self.username = username
        self.groups = groups
    }

    public static func fromJSON(_ json: [String: Any]) throws -> OIDCUser {
        guard let userId = json["userId"] as? String else {
            throw OIDCError.malformedDescriptor("userId")
        }
        guard let username = json["username"] as? String else {
            throw OIDCError.malformedDescriptor("username")
        }
        let groups = (json["groups"] as? [String]) ?? []
        return OIDCUser(userId: userId, username: username, groups: groups)
    }
}

/// Configuration for a single OIDC identity provider.
public struct OIDCProviderConfig: Sendable, Equatable, Codable {
    public let authorizeUrl: String
    public let clientId: String
    public let scopes: [String]
    public let kind: String

    public init(authorizeUrl: String, clientId: String, scopes: [String], kind: String) {
        self.authorizeUrl = authorizeUrl
        self.clientId = clientId
        self.scopes = scopes
        self.kind = kind
    }

    public static func fromJSON(_ json: [String: Any]) throws -> OIDCProviderConfig {
        guard let authorizeUrl = json["authorizeUrl"] as? String else {
            throw OIDCError.malformedDescriptor("authorizeUrl")
        }
        guard let clientId = json["clientId"] as? String else {
            throw OIDCError.malformedDescriptor("clientId")
        }
        guard let scopes = json["scopes"] as? [String] else {
            throw OIDCError.malformedDescriptor("scopes")
        }
        guard let kind = json["kind"] as? String else {
            throw OIDCError.malformedDescriptor("kind")
        }
        return OIDCProviderConfig(
            authorizeUrl: authorizeUrl,
            clientId: clientId,
            scopes: scopes,
            kind: kind
        )
    }
}
