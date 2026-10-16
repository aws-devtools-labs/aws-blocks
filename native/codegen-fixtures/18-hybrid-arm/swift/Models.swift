import Foundation


public enum Capability: String, Codable {
    case webauthnGet = "webauthn-get"
    case webauthnCreate = "webauthn-create"
}

public enum AuthActionMethod: String, Codable {
    case get = "GET"
    case post = "POST"
}

public struct AuthAction: Codable {
    public let capability: Capability?
    public let fields: [AuthField]
    public let label: String
    public let method: AuthActionMethod?
    public let name: String
    public let url: String?

    enum CodingKeys: String, CodingKey {
        case capability
        case fields
        case label
        case method
        case name
        case url
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.capability, forKey: .capability)
        try c.encode(self.fields, forKey: .fields)
        try c.encode(self.label, forKey: .label)
        try c.encodeIfPresent(self.method, forKey: .method)
        try c.encode(self.name, forKey: .name)
        try c.encodeIfPresent(self.url, forKey: .url)
    }

    public init(capability: Capability? = nil, fields: [AuthField], label: String, method: AuthActionMethod? = nil, name: String, url: String? = nil) {
        self.capability = capability
        self.fields = fields
        self.label = label
        self.method = method
        self.name = name
        self.url = url
    }
}

public enum AuthFieldType: String, Codable {
    case number
    case password
    case email
    case text
    case tel
    case hidden
}

public struct AuthField: Codable {
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

public enum AuthStateState: String, Codable {
    case signedOut
    case signedIn
    case confirmingSignUp
    case confirmingSignIn
    case confirmingMfa
    case confirmingPasswordReset
}

public struct AuthState: Codable {
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

public struct AuthUser: Codable {
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

public struct Todo: Codable {
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