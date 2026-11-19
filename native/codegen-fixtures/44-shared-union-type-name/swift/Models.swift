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
    case email
    case password
    case text
    case tel
    case hidden
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "number": self = .number
        case "email": self = .email
        case "password": self = .password
        case "text": self = .text
        case "tel": self = .tel
        case "hidden": self = .hidden
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .number: return "number"
        case .email: return "email"
        case .password: return "password"
        case .text: return "text"
        case .tel: return "tel"
        case .hidden: return "hidden"
        case .unknown(let value): return value
        }
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.number, .number): return true
        case (.email, .email): return true
        case (.password, .password): return true
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
        case .email: hasher.combine(1)
        case .password: hasher.combine(2)
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

public nonisolated enum AuthActionInput: Codable, Sendable {
    case signUp(SignUp)
    case resetPassword(ResetPassword)
    case signIn(SignIn)
    case signInWithPasskey(SignInWithPasskey)
    case confirmSignUp(ConfirmSignUp)
    case resendSignUpCode(ResendSignUpCode)
    case signOut
    case confirmResetPassword(ConfirmResetPassword)
    case autoSignIn(AutoSignIn)
    case confirmSignIn(ConfirmSignIn)
    case startPasskeyRegistration
    case completePasskeyRegistration(CompletePasskeyRegistration)
    case listPasskeys
    case deletePasskey(DeletePasskey)
    case setUpTotp
    case verifyTotpSetup(VerifyTotpSetup)
    case getMfaPreference
    case updateMfaPreference(UpdateMfaPreference)

    enum CodingKeys: String, CodingKey {
        case action
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .signUp(let params):
            try container.encode("signUp", forKey: .action)
            try params.encode(to: encoder)
        case .resetPassword(let params):
            try container.encode("resetPassword", forKey: .action)
            try params.encode(to: encoder)
        case .signIn(let params):
            try container.encode("signIn", forKey: .action)
            try params.encode(to: encoder)
        case .signInWithPasskey(let params):
            try container.encode("signInWithPasskey", forKey: .action)
            try params.encode(to: encoder)
        case .confirmSignUp(let params):
            try container.encode("confirmSignUp", forKey: .action)
            try params.encode(to: encoder)
        case .resendSignUpCode(let params):
            try container.encode("resendSignUpCode", forKey: .action)
            try params.encode(to: encoder)
        case .signOut:
            try container.encode("signOut", forKey: .action)
        case .confirmResetPassword(let params):
            try container.encode("confirmResetPassword", forKey: .action)
            try params.encode(to: encoder)
        case .autoSignIn(let params):
            try container.encode("autoSignIn", forKey: .action)
            try params.encode(to: encoder)
        case .confirmSignIn(let params):
            try container.encode("confirmSignIn", forKey: .action)
            try params.encode(to: encoder)
        case .startPasskeyRegistration:
            try container.encode("startPasskeyRegistration", forKey: .action)
        case .completePasskeyRegistration(let params):
            try container.encode("completePasskeyRegistration", forKey: .action)
            try params.encode(to: encoder)
        case .listPasskeys:
            try container.encode("listPasskeys", forKey: .action)
        case .deletePasskey(let params):
            try container.encode("deletePasskey", forKey: .action)
            try params.encode(to: encoder)
        case .setUpTotp:
            try container.encode("setUpTotp", forKey: .action)
        case .verifyTotpSetup(let params):
            try container.encode("verifyTotpSetup", forKey: .action)
            try params.encode(to: encoder)
        case .getMfaPreference:
            try container.encode("getMfaPreference", forKey: .action)
        case .updateMfaPreference(let params):
            try container.encode("updateMfaPreference", forKey: .action)
            try params.encode(to: encoder)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let disc = try container.decode(String.self, forKey: .action)
        switch disc {
        case "signUp": self = .signUp(try SignUp(from: decoder))
        case "resetPassword": self = .resetPassword(try ResetPassword(from: decoder))
        case "signIn": self = .signIn(try SignIn(from: decoder))
        case "signInWithPasskey": self = .signInWithPasskey(try SignInWithPasskey(from: decoder))
        case "confirmSignUp": self = .confirmSignUp(try ConfirmSignUp(from: decoder))
        case "resendSignUpCode": self = .resendSignUpCode(try ResendSignUpCode(from: decoder))
        case "signOut": self = .signOut
        case "confirmResetPassword": self = .confirmResetPassword(try ConfirmResetPassword(from: decoder))
        case "autoSignIn": self = .autoSignIn(try AutoSignIn(from: decoder))
        case "confirmSignIn": self = .confirmSignIn(try ConfirmSignIn(from: decoder))
        case "startPasskeyRegistration": self = .startPasskeyRegistration
        case "completePasskeyRegistration": self = .completePasskeyRegistration(try CompletePasskeyRegistration(from: decoder))
        case "listPasskeys": self = .listPasskeys
        case "deletePasskey": self = .deletePasskey(try DeletePasskey(from: decoder))
        case "setUpTotp": self = .setUpTotp
        case "verifyTotpSetup": self = .verifyTotpSetup(try VerifyTotpSetup(from: decoder))
        case "getMfaPreference": self = .getMfaPreference
        case "updateMfaPreference": self = .updateMfaPreference(try UpdateMfaPreference(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(forKey: .action, in: container, debugDescription: "Unknown value: \(disc)")
        }
    }

    public struct SignUp: Codable, Sendable {
        public let password: String
        public let username: String
        public let attributes: [String: String]

        public init(password: String, username: String, attributes: [String: String] = [:]) {
            self.password = password
            self.username = username
            self.attributes = attributes
        }

        private struct DynamicKey: CodingKey {
            var stringValue: String
            var intValue: Int? { nil }
            init?(stringValue: String) { self.stringValue = stringValue }
            init?(intValue: Int) { return nil }
        }

        private static let fixedFieldNames: Set<String> = [
            "password",
            "username",
            "action",
        ]

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: DynamicKey.self)
            try c.encode(self.password, forKey: DynamicKey(stringValue: "password")!)
            try c.encode(self.username, forKey: DynamicKey(stringValue: "username")!)
            for (k, v) in self.attributes where !Self.fixedFieldNames.contains(k) {
                try c.encode(v, forKey: DynamicKey(stringValue: k)!)
            }
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: DynamicKey.self)
            self.password = try c.decode(String.self, forKey: DynamicKey(stringValue: "password")!)
            self.username = try c.decode(String.self, forKey: DynamicKey(stringValue: "username")!)
            var extras: [String: String] = [:]
            for key in c.allKeys where !Self.fixedFieldNames.contains(key.stringValue) {
                extras[key.stringValue] = try c.decode(String.self, forKey: key)
            }
            self.attributes = extras
        }
    }

    public struct ResetPassword: Codable, Sendable {
        public let username: String

        public init(username: String) {
            self.username = username
        }
    }

    public struct SignIn: Codable, Sendable {
        public let password: String
        public let username: String

        public init(password: String, username: String) {
            self.password = password
            self.username = username
        }
    }

    public struct SignInWithPasskey: Codable, Sendable {
        public let username: String

        public init(username: String) {
            self.username = username
        }
    }

    public struct ConfirmSignUp: Codable, Sendable {
        public let code: String
        public let password: String?
        public let username: String

        enum CodingKeys: String, CodingKey {
            case code
            case password
            case username
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(self.code, forKey: .code)
            try c.encodeIfPresent(self.password, forKey: .password)
            try c.encode(self.username, forKey: .username)
        }

        public init(code: String, password: String? = nil, username: String) {
            self.code = code
            self.password = password
            self.username = username
        }
    }

    public struct ResendSignUpCode: Codable, Sendable {
        public let username: String

        public init(username: String) {
            self.username = username
        }
    }

    public struct ConfirmResetPassword: Codable, Sendable {
        public let code: String
        public let newPassword: String
        public let username: String

        public init(code: String, newPassword: String, username: String) {
            self.code = code
            self.newPassword = newPassword
            self.username = username
        }
    }

    public struct AutoSignIn: Codable, Sendable {
        public let username: String

        public init(username: String) {
            self.username = username
        }
    }

    public struct ConfirmSignIn: Codable, Sendable {
        public let session: String
        public let challenge: ConfirmSignInChallenge

        public struct Code: Codable, Sendable {
            public let code: String

            public init(code: String) {
                self.code = code
            }
        }

        public struct MfaType: Codable, Sendable {
            public let mfaType: String

            public init(mfaType: String) {
                self.mfaType = mfaType
            }
        }

        public struct NewPassword: Codable, Sendable {
            public let newPassword: String

            public init(newPassword: String) {
                self.newPassword = newPassword
            }
        }

        public struct TotpSetup: Codable, Sendable {
            public let code: String
            public let sharedSecret: String

            public init(code: String, sharedSecret: String) {
                self.code = code
                self.sharedSecret = sharedSecret
            }
        }

        public struct Email: Codable, Sendable {
            public let email: String

            public init(email: String) {
                self.email = email
            }
        }

        public struct Password: Codable, Sendable {
            public let password: String

            public init(password: String) {
                self.password = password
            }
        }

        public struct FirstFactor: Codable, Sendable {
            public let firstFactor: String

            public init(firstFactor: String) {
                self.firstFactor = firstFactor
            }
        }

        public struct Webauthn: Codable, Sendable {
            public let credential: String

            public init(credential: String) {
                self.credential = credential
            }
        }

        public enum ConfirmSignInChallenge: Codable, Sendable {
            case code(Code)
            case mfaType(MfaType)
            case newPassword(NewPassword)
            case totpSetup(TotpSetup)
            case email(Email)
            case password(Password)
            case firstFactor(FirstFactor)
            case webauthn(Webauthn)

            enum CodingKeys: String, CodingKey {
                case challenge
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .code(let params):
                    try container.encode("code", forKey: .challenge)
                    try params.encode(to: encoder)
                case .mfaType(let params):
                    try container.encode("mfaType", forKey: .challenge)
                    try params.encode(to: encoder)
                case .newPassword(let params):
                    try container.encode("newPassword", forKey: .challenge)
                    try params.encode(to: encoder)
                case .totpSetup(let params):
                    try container.encode("totpSetup", forKey: .challenge)
                    try params.encode(to: encoder)
                case .email(let params):
                    try container.encode("email", forKey: .challenge)
                    try params.encode(to: encoder)
                case .password(let params):
                    try container.encode("password", forKey: .challenge)
                    try params.encode(to: encoder)
                case .firstFactor(let params):
                    try container.encode("firstFactor", forKey: .challenge)
                    try params.encode(to: encoder)
                case .webauthn(let params):
                    try container.encode("webauthn", forKey: .challenge)
                    try params.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let disc = try container.decode(String.self, forKey: .challenge)
                switch disc {
                case "code": self = .code(try Code(from: decoder))
                case "mfaType": self = .mfaType(try MfaType(from: decoder))
                case "newPassword": self = .newPassword(try NewPassword(from: decoder))
                case "totpSetup": self = .totpSetup(try TotpSetup(from: decoder))
                case "email": self = .email(try Email(from: decoder))
                case "password": self = .password(try Password(from: decoder))
                case "firstFactor": self = .firstFactor(try FirstFactor(from: decoder))
                case "webauthn": self = .webauthn(try Webauthn(from: decoder))
                default:
                    throw DecodingError.dataCorruptedError(forKey: .challenge, in: container, debugDescription: "Unknown value: \(disc)")
                }
            }
        }

        public init(session: String, challenge: ConfirmSignInChallenge) {
            self.session = session
            self.challenge = challenge
        }

        private enum OuterCodingKeys: String, CodingKey {
            case session
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: OuterCodingKeys.self)
            try c.encode(self.session, forKey: .session)
            try self.challenge.encode(to: encoder)
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: OuterCodingKeys.self)
            self.session = try c.decode(String.self, forKey: .session)
            self.challenge = try ConfirmSignInChallenge(from: decoder)
        }
    }

    public struct CompletePasskeyRegistration: Codable, Sendable {
        public let credential: String

        public init(credential: String) {
            self.credential = credential
        }
    }

    public struct DeletePasskey: Codable, Sendable {
        public let credentialId: String

        public init(credentialId: String) {
            self.credentialId = credentialId
        }
    }

    public struct VerifyTotpSetup: Codable, Sendable {
        public let code: String

        public init(code: String) {
            self.code = code
        }
    }

    public struct UpdateMfaPreference: Codable, Sendable {
        public let email: Email?
        public let sms: Sms?
        public let totp: Totp?

        enum CodingKeys: String, CodingKey {
            case email
            case sms
            case totp
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encodeIfPresent(self.email, forKey: .email)
            try c.encodeIfPresent(self.sms, forKey: .sms)
            try c.encodeIfPresent(self.totp, forKey: .totp)
        }

        public init(email: Email? = nil, sms: Sms? = nil, totp: Totp? = nil) {
            self.email = email
            self.sms = sms
            self.totp = totp
        }

        public enum Email: String, Codable, Sendable {
            case enabled = "ENABLED"
            case disabled = "DISABLED"
            case preferred = "PREFERRED"
            case notPreferred = "NOT_PREFERRED"
        }

        public enum Sms: String, Codable, Sendable {
            case enabled = "ENABLED"
            case disabled = "DISABLED"
            case preferred = "PREFERRED"
            case notPreferred = "NOT_PREFERRED"
        }

        public enum Totp: String, Codable, Sendable {
            case enabled = "ENABLED"
            case disabled = "DISABLED"
            case preferred = "PREFERRED"
            case notPreferred = "NOT_PREFERRED"
        }
    }
}