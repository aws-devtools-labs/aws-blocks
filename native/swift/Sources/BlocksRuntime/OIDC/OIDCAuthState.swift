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
public struct OIDCUser: Sendable, Equatable, Codable {
    public let userId: String
    public let username: String
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
