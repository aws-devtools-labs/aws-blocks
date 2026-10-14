import Foundation
import BlocksRuntime

public final nonisolated class AuthApi: Sendable {
    private let client: BlocksClient

    public init(client: BlocksClient) {
        self.client = client
    }

    @available(*, deprecated, message: "Use blocks.authApi from one Blocks() or Blocks(server:) you hold")
    public convenience init(server: BlocksServer = Servers.local) {
        self.init(client: BlocksClient(server: server))
    }

    /// Calls `authApi.setAuthState`.
    public func setAuthState(input: SetAuthState.Input) async throws -> AuthState {
        let request = BlocksRequest(method: "authApi.setAuthState", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for authApi.setAuthState") }
        return try JSONDecoder().decode(AuthState.self, from: result)
    }

    public enum SetAuthState {

        public struct SignIn: Codable {
            public let password: String
            public let username: String
        }

        public struct SignUp: Codable {
            public let password: String
            public let username: String
            public let attributes: [String: String]
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
        }

        public struct ResendSignUpCode: Codable {
            public let username: String
        }

        public struct ResetPassword: Codable {
            public let username: String
        }

        public struct ConfirmResetPassword: Codable {
            public let code: String
            public let newPassword: String
            public let username: String
        }

        public struct AutoSignIn: Codable {
            public let username: String
        }

        public struct ConfirmSignIn: Codable {
            public let session: String
            public let challenge: ConfirmSignInChallenge

            public struct Code: Codable {
                public let code: String
            }

            public struct MfaType: Codable {
                public let mfaType: String
            }

            public struct NewPassword: Codable {
                public let newPassword: String
            }

            public struct TotpSetup: Codable {
                public let code: String
                public let sharedSecret: String
            }

            public struct Email: Codable {
                public let email: String
            }

            public struct Password: Codable {
                public let password: String
            }

            public struct FirstFactor: Codable {
                public let firstFactor: String
            }

            public enum ConfirmSignInChallenge: Codable {
                case code(Code)
                case mfaType(MfaType)
                case newPassword(NewPassword)
                case totpSetup(TotpSetup)
                case email(Email)
                case password(Password)
                case firstFactor(FirstFactor)

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

        public enum Input: Codable {
            case signIn(SignIn)
            case signUp(SignUp)
            case confirmSignUp(ConfirmSignUp)
            case resendSignUpCode(ResendSignUpCode)
            case signOut
            case resetPassword(ResetPassword)
            case confirmResetPassword(ConfirmResetPassword)
            case autoSignIn(AutoSignIn)
            case confirmSignIn(ConfirmSignIn)

            enum CodingKeys: String, CodingKey {
                case action
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .signIn(let params):
                    try container.encode("signIn", forKey: .action)
                    try params.encode(to: encoder)
                case .signUp(let params):
                    try container.encode("signUp", forKey: .action)
                    try params.encode(to: encoder)
                case .confirmSignUp(let params):
                    try container.encode("confirmSignUp", forKey: .action)
                    try params.encode(to: encoder)
                case .resendSignUpCode(let params):
                    try container.encode("resendSignUpCode", forKey: .action)
                    try params.encode(to: encoder)
                case .signOut:
                    try container.encode("signOut", forKey: .action)
                case .resetPassword(let params):
                    try container.encode("resetPassword", forKey: .action)
                    try params.encode(to: encoder)
                case .confirmResetPassword(let params):
                    try container.encode("confirmResetPassword", forKey: .action)
                    try params.encode(to: encoder)
                case .autoSignIn(let params):
                    try container.encode("autoSignIn", forKey: .action)
                    try params.encode(to: encoder)
                case .confirmSignIn(let params):
                    try container.encode("confirmSignIn", forKey: .action)
                    try params.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let disc = try container.decode(String.self, forKey: .action)
                switch disc {
                case "signIn": self = .signIn(try SignIn(from: decoder))
                case "signUp": self = .signUp(try SignUp(from: decoder))
                case "confirmSignUp": self = .confirmSignUp(try ConfirmSignUp(from: decoder))
                case "resendSignUpCode": self = .resendSignUpCode(try ResendSignUpCode(from: decoder))
                case "signOut": self = .signOut
                case "resetPassword": self = .resetPassword(try ResetPassword(from: decoder))
                case "confirmResetPassword": self = .confirmResetPassword(try ConfirmResetPassword(from: decoder))
                case "autoSignIn": self = .autoSignIn(try AutoSignIn(from: decoder))
                case "confirmSignIn": self = .confirmSignIn(try ConfirmSignIn(from: decoder))
                default:
                    throw DecodingError.dataCorruptedError(forKey: .action, in: container, debugDescription: "Unknown value: \(disc)")
                }
            }
        }
    }
}


// MARK: - Blocks

/// One BlocksClient, so one URLSession (RPC and OIDC calls) and one token store, for every namespace in this spec;
/// file transfers and realtime use the shared runtime session. Hold one while the backend is in use: `let blocks = Blocks()`.
public final nonisolated class Blocks: Sendable {
    /// The server every API calls.
    public let server: BlocksRuntime.BlocksServer
    /// The client every API runs on.
    public let client: BlocksRuntime.BlocksClient

    public let authApi: AuthApi

    /// Defaults to the spec's first server; a `session` you pass stays yours.
    public init(
        server: BlocksRuntime.BlocksServer = Servers.local,
        session: URLSession? = nil,
        tokenStore: any BlocksRuntime.TokenStore = BlocksRuntime.InMemoryTokenStore()
    ) {
        self.server = server
        self.client = BlocksRuntime.BlocksClient(server: server, session: session, tokenStore: tokenStore)
        self.authApi = .init(client: client)
    }

    /// Later calls throw ClientClosedError; calls in flight finish, then the session this instance created is released.
    public func close() {
        client.close()
    }
}

// MARK: - Servers

public nonisolated enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}