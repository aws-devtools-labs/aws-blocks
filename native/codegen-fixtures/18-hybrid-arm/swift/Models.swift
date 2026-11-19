import Foundation


public nonisolated enum AuthActionCapability: RawRepresentable, Codable, Hashable, Sendable {
    case webauthnGet
    case webauthnCreate
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "webauthn-get": self = .webauthnGet
        case "webauthn-create": self = .webauthnCreate
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .webauthnGet: return "webauthn-get"
        case .webauthnCreate: return "webauthn-create"
        case .unknown(let value): return value
        }
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.webauthnGet, .webauthnGet): return true
        case (.webauthnCreate, .webauthnCreate): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .webauthnGet: hasher.combine(0)
        case .webauthnCreate: hasher.combine(1)
        case .unknown(let value):
            hasher.combine(2)
            hasher.combine(value)
        }
    }
}

public nonisolated enum AuthActionMethod: RawRepresentable, Codable, Hashable, Sendable {
    case get
    case post
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "GET": self = .get
        case "POST": self = .post
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .get: return "GET"
        case .post: return "POST"
        case .unknown(let value): return value
        }
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.get, .get): return true
        case (.post, .post): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .get: hasher.combine(0)
        case .post: hasher.combine(1)
        case .unknown(let value):
            hasher.combine(2)
            hasher.combine(value)
        }
    }
}

public nonisolated struct AuthAction: Codable, Sendable {
    public let capability: AuthActionCapability?
    public let fields: [AuthField]
    public let label: String
    public let method: AuthActionMethod?
    public let name: String
    public let unavailable: String?
    public let url: String?

    enum CodingKeys: String, CodingKey {
        case capability
        case fields
        case label
        case method
        case name
        case unavailable
        case url
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.capability, forKey: .capability)
        try c.encode(self.fields, forKey: .fields)
        try c.encode(self.label, forKey: .label)
        try c.encodeIfPresent(self.method, forKey: .method)
        try c.encode(self.name, forKey: .name)
        try c.encodeIfPresent(self.unavailable, forKey: .unavailable)
        try c.encodeIfPresent(self.url, forKey: .url)
    }

    public init(capability: AuthActionCapability? = nil, fields: [AuthField], label: String, method: AuthActionMethod? = nil, name: String, unavailable: String? = nil, url: String? = nil) {
        self.capability = capability
        self.fields = fields
        self.label = label
        self.method = method
        self.name = name
        self.unavailable = unavailable
        self.url = url
    }
}

public nonisolated enum AuthFieldType: RawRepresentable, Codable, Hashable, Sendable {
    case number
    case password
    case email
    case text
    case tel
    case hidden
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "number": self = .number
        case "password": self = .password
        case "email": self = .email
        case "text": self = .text
        case "tel": self = .tel
        case "hidden": self = .hidden
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .number: return "number"
        case .password: return "password"
        case .email: return "email"
        case .text: return "text"
        case .tel: return "tel"
        case .hidden: return "hidden"
        case .unknown(let value): return value
        }
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.number, .number): return true
        case (.password, .password): return true
        case (.email, .email): return true
        case (.text, .text): return true
        case (.tel, .tel): return true
        case (.hidden, .hidden): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .number: hasher.combine(0)
        case .password: hasher.combine(1)
        case .email: hasher.combine(2)
        case .text: hasher.combine(3)
        case .tel: hasher.combine(4)
        case .hidden: hasher.combine(5)
        case .unknown(let value):
            hasher.combine(6)
            hasher.combine(value)
        }
    }
}

public nonisolated struct AuthField: Codable, Sendable {
    public let defaultValue: String?
    public let label: String
    public let name: String
    public let required: Bool
    public let `type`: AuthFieldType

    enum CodingKeys: String, CodingKey {
        case defaultValue
        case label
        case name
        case required
        case `type` = "type"
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.defaultValue, forKey: .defaultValue)
        try c.encode(self.label, forKey: .label)
        try c.encode(self.name, forKey: .name)
        try c.encode(self.required, forKey: .required)
        try c.encode(self.`type`, forKey: .`type`)
    }

    public init(defaultValue: String? = nil, label: String, name: String, required: Bool, `type`: AuthFieldType) {
        self.defaultValue = defaultValue
        self.label = label
        self.name = name
        self.required = required
        self.`type` = `type`
    }
}

public nonisolated enum AuthStateState: RawRepresentable, Codable, Hashable, Sendable {
    case signedOut
    case signedIn
    case confirmingSignUp
    case confirmingSignIn
    case confirmingMfa
    case confirmingPasswordReset
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "signedOut": self = .signedOut
        case "signedIn": self = .signedIn
        case "confirmingSignUp": self = .confirmingSignUp
        case "confirmingSignIn": self = .confirmingSignIn
        case "confirmingMfa": self = .confirmingMfa
        case "confirmingPasswordReset": self = .confirmingPasswordReset
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .signedOut: return "signedOut"
        case .signedIn: return "signedIn"
        case .confirmingSignUp: return "confirmingSignUp"
        case .confirmingSignIn: return "confirmingSignIn"
        case .confirmingMfa: return "confirmingMfa"
        case .confirmingPasswordReset: return "confirmingPasswordReset"
        case .unknown(let value): return value
        }
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.signedOut, .signedOut): return true
        case (.signedIn, .signedIn): return true
        case (.confirmingSignUp, .confirmingSignUp): return true
        case (.confirmingSignIn, .confirmingSignIn): return true
        case (.confirmingMfa, .confirmingMfa): return true
        case (.confirmingPasswordReset, .confirmingPasswordReset): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .signedOut: hasher.combine(0)
        case .signedIn: hasher.combine(1)
        case .confirmingSignUp: hasher.combine(2)
        case .confirmingSignIn: hasher.combine(3)
        case .confirmingMfa: hasher.combine(4)
        case .confirmingPasswordReset: hasher.combine(5)
        case .unknown(let value):
            hasher.combine(6)
            hasher.combine(value)
        }
    }
}

public nonisolated struct AuthState: Codable, Sendable {
    public let actions: [AuthAction]
    public let error: String?
    public let errorName: String?
    public let retriable: Bool?
    public let state: AuthStateState
    public let user: AuthUser?

    enum CodingKeys: String, CodingKey {
        case actions
        case error
        case errorName
        case retriable
        case state
        case user
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.actions, forKey: .actions)
        try c.encodeIfPresent(self.error, forKey: .error)
        try c.encodeIfPresent(self.errorName, forKey: .errorName)
        try c.encodeIfPresent(self.retriable, forKey: .retriable)
        try c.encode(self.state, forKey: .state)
        try c.encodeIfPresent(self.user, forKey: .user)
    }

    public init(actions: [AuthAction], error: String? = nil, errorName: String? = nil, retriable: Bool? = nil, state: AuthStateState, user: AuthUser? = nil) {
        self.actions = actions
        self.error = error
        self.errorName = errorName
        self.retriable = retriable
        self.state = state
        self.user = user
    }
}

public nonisolated struct AuthUser: Codable, Sendable {
    public let displayName: String?
    public let userId: String
    public let username: String

    enum CodingKeys: String, CodingKey {
        case displayName
        case userId
        case username
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.displayName, forKey: .displayName)
        try c.encode(self.userId, forKey: .userId)
        try c.encode(self.username, forKey: .username)
    }

    public init(displayName: String? = nil, userId: String, username: String) {
        self.displayName = displayName
        self.userId = userId
        self.username = username
    }
}

public nonisolated struct Todo: Codable, Sendable {
    public let completed: Bool
    public let createdAt: Double
    public let priority: Double
    public let title: String
    public let todoId: String
    public let userId: String

    public init(completed: Bool, createdAt: Double, priority: Double, title: String, todoId: String, userId: String) {
        self.completed = completed
        self.createdAt = createdAt
        self.priority = priority
        self.title = title
        self.todoId = todoId
        self.userId = userId
    }
}