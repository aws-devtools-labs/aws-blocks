import Foundation
import BlocksRuntime


public nonisolated enum AuthenticatedUserGroups: String, Codable {
    case admins
    case users
}

public nonisolated enum AuthenticatedUserSignInProvider: String, Codable {
    case password
}

public nonisolated struct AuthenticatedUser: Codable {
    public let attributes: [String: String?]
    public let claims: [String: JSONValue]?
    public let federatedIdentity: FederatedIdentity?
    public let groups: [AuthenticatedUserGroups]
    public let signInProvider: AuthenticatedUserSignInProvider
    public let userId: String
    public let userSub: String
    public let username: String

    enum CodingKeys: String, CodingKey {
        case attributes
        case claims
        case federatedIdentity
        case groups
        case signInProvider
        case userId
        case userSub
        case username
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.attributes, forKey: .attributes)
        try c.encodeIfPresent(self.claims, forKey: .claims)
        try c.encodeIfPresent(self.federatedIdentity, forKey: .federatedIdentity)
        try c.encode(self.groups, forKey: .groups)
        try c.encode(self.signInProvider, forKey: .signInProvider)
        try c.encode(self.userId, forKey: .userId)
        try c.encode(self.userSub, forKey: .userSub)
        try c.encode(self.username, forKey: .username)
    }

    public init(attributes: [String: String?], claims: [String: JSONValue]? = nil, federatedIdentity: FederatedIdentity? = nil, groups: [AuthenticatedUserGroups], signInProvider: AuthenticatedUserSignInProvider, userId: String, userSub: String, username: String) {
        self.attributes = attributes
        self.claims = claims
        self.federatedIdentity = federatedIdentity
        self.groups = groups
        self.signInProvider = signInProvider
        self.userId = userId
        self.userSub = userSub
        self.username = username
    }
}

public nonisolated enum CodeDeliveryDetailsDeliveryMedium: String, Codable {
    case sms = "SMS"
    case email = "EMAIL"
    case phoneNumber = "PHONE_NUMBER"
}

public nonisolated struct CodeDeliveryDetails: Codable {
    public let attributeName: String
    public let deliveryMedium: CodeDeliveryDetailsDeliveryMedium
    public let destination: String

    public init(attributeName: String, deliveryMedium: CodeDeliveryDetailsDeliveryMedium, destination: String) {
        self.attributeName = attributeName
        self.deliveryMedium = deliveryMedium
        self.destination = destination
    }
}

public nonisolated struct FederatedIdentity: Codable {
    public let providerId: String
    public let sub: String

    public init(providerId: String, sub: String) {
        self.providerId = providerId
        self.sub = sub
    }
}