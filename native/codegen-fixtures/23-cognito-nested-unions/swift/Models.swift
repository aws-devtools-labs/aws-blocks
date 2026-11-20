import Foundation
import BlocksRuntime


public nonisolated enum AuthenticatedUserGroups: RawRepresentable, Codable, Hashable, Sendable {
    case users
    case admins
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "users": self = .users
        case "admins": self = .admins
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .users: return "users"
        case .admins: return "admins"
        case .unknown(let value): return value
        }
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.users, .users): return true
        case (.admins, .admins): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .users: hasher.combine(0)
        case .admins: hasher.combine(1)
        case .unknown(let value):
            hasher.combine(2)
            hasher.combine(value)
        }
    }
}

public nonisolated enum AuthenticatedUserSignInProvider: RawRepresentable, Codable, Hashable, Sendable {
    case password
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "password": self = .password
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .password: return "password"
        case .unknown(let value): return value
        }
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.password, .password): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .password: hasher.combine(0)
        case .unknown(let value):
            hasher.combine(1)
            hasher.combine(value)
        }
    }
}

public nonisolated struct AuthenticatedUser: Codable, Sendable {
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

public nonisolated enum CodeDeliveryDetailsDeliveryMedium: RawRepresentable, Codable, Hashable, Sendable {
    case sms
    case email
    case phoneNumber
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "SMS": self = .sms
        case "EMAIL": self = .email
        case "PHONE_NUMBER": self = .phoneNumber
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .sms: return "SMS"
        case .email: return "EMAIL"
        case .phoneNumber: return "PHONE_NUMBER"
        case .unknown(let value): return value
        }
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.sms, .sms): return true
        case (.email, .email): return true
        case (.phoneNumber, .phoneNumber): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .sms: hasher.combine(0)
        case .email: hasher.combine(1)
        case .phoneNumber: hasher.combine(2)
        case .unknown(let value):
            hasher.combine(3)
            hasher.combine(value)
        }
    }
}

public nonisolated struct CodeDeliveryDetails: Codable, Sendable {
    public let attributeName: String
    public let deliveryMedium: CodeDeliveryDetailsDeliveryMedium
    public let destination: String

    public init(attributeName: String, deliveryMedium: CodeDeliveryDetailsDeliveryMedium, destination: String) {
        self.attributeName = attributeName
        self.deliveryMedium = deliveryMedium
        self.destination = destination
    }
}

public nonisolated struct FederatedIdentity: Codable, Sendable {
    public let providerId: String
    public let sub: String

    public init(providerId: String, sub: String) {
        self.providerId = providerId
        self.sub = sub
    }
}