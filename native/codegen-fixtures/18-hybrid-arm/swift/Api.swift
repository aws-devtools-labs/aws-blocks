import Foundation
import BlocksRuntime

public class AuthApi {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `authApi.setAuthState`.
    public func setAuthState(input: SetAuthState.Input) async throws -> AuthState {
        let request = BlocksRequest(method: "authApi.setAuthState", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for authApi.setAuthState") }
        return try JSONDecoder().decode(AuthState.self, from: result)
    }

    public enum SetAuthState {

        public struct SignUp: Codable {
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

        public struct ResetPassword: Codable {
            public let username: String

            public init(username: String) {
                self.username = username
            }
        }

        public struct SignIn: Codable {
            public let password: String
            public let username: String

            public init(password: String, username: String) {
                self.password = password
                self.username = username
            }
        }

        public struct SignInWithPasskey: Codable {
            public let username: String

            public init(username: String) {
                self.username = username
            }
        }

        public struct ConfirmSignUp: Codable {
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

        public struct ResendSignUpCode: Codable {
            public let username: String

            public init(username: String) {
                self.username = username
            }
        }

        public struct ConfirmResetPassword: Codable {
            public let code: String
            public let newPassword: String
            public let username: String

            public init(code: String, newPassword: String, username: String) {
                self.code = code
                self.newPassword = newPassword
                self.username = username
            }
        }

        public struct AutoSignIn: Codable {
            public let username: String

            public init(username: String) {
                self.username = username
            }
        }

        public struct ConfirmSignIn: Codable {
            public let session: String
            public let challenge: ConfirmSignInChallenge

            public struct Code: Codable {
                public let code: String

                public init(code: String) {
                    self.code = code
                }
            }

            public struct MfaType: Codable {
                public let mfaType: String

                public init(mfaType: String) {
                    self.mfaType = mfaType
                }
            }

            public struct NewPassword: Codable {
                public let newPassword: String

                public init(newPassword: String) {
                    self.newPassword = newPassword
                }
            }

            public struct TotpSetup: Codable {
                public let code: String
                public let sharedSecret: String

                public init(code: String, sharedSecret: String) {
                    self.code = code
                    self.sharedSecret = sharedSecret
                }
            }

            public struct Email: Codable {
                public let email: String

                public init(email: String) {
                    self.email = email
                }
            }

            public struct Password: Codable {
                public let password: String

                public init(password: String) {
                    self.password = password
                }
            }

            public struct FirstFactor: Codable {
                public let firstFactor: String

                public init(firstFactor: String) {
                    self.firstFactor = firstFactor
                }
            }

            public struct Webauthn: Codable {
                public let credential: String

                public init(credential: String) {
                    self.credential = credential
                }
            }

            public enum ConfirmSignInChallenge: Codable {
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

        public struct CompletePasskeyRegistration: Codable {
            public let credential: String

            public init(credential: String) {
                self.credential = credential
            }
        }

        public struct DeletePasskey: Codable {
            public let credentialId: String

            public init(credentialId: String) {
                self.credentialId = credentialId
            }
        }

        public enum Input: Codable {
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
                default:
                    throw DecodingError.dataCorruptedError(forKey: .action, in: container, debugDescription: "Unknown value: \(disc)")
                }
            }
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}