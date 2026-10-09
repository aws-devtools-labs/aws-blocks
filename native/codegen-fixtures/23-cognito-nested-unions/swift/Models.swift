import Foundation
import BlocksRuntime


public enum GroupValue: String, Codable {
    case admins
    case users
}

public enum SignInProvider: String, Codable {
    case password
}

public struct AuthenticatedUser: Codable {
    public let attributes: [String: String?]
    public let claims: [String: JSONValue]?
    public let groups: [GroupValue]
    public let signInProvider: SignInProvider
    public let userId: String
    public let userSub: String
    public let username: String

    enum CodingKeys: String, CodingKey {
        case attributes
        case claims
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
        try c.encode(self.groups, forKey: .groups)
        try c.encode(self.signInProvider, forKey: .signInProvider)
        try c.encode(self.userId, forKey: .userId)
        try c.encode(self.userSub, forKey: .userSub)
        try c.encode(self.username, forKey: .username)
    }

    public init(attributes: [String: String?], claims: [String: JSONValue]? = nil, groups: [GroupValue], signInProvider: SignInProvider, userId: String, userSub: String, username: String) {
        self.attributes = attributes
        self.claims = claims
        self.groups = groups
        self.signInProvider = signInProvider
        self.userId = userId
        self.userSub = userSub
        self.username = username
    }
}

public enum DeliveryMedium: String, Codable {
    case sms = "SMS"
    case email = "EMAIL"
    case phoneNumber = "PHONE_NUMBER"
}

public struct CodeDeliveryDetails: Codable {
    public let attributeName: String
    public let deliveryMedium: DeliveryMedium
    public let destination: String

    public init(attributeName: String, deliveryMedium: DeliveryMedium, destination: String) {
        self.attributeName = attributeName
        self.deliveryMedium = deliveryMedium
        self.destination = destination
    }
}