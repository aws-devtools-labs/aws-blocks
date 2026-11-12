import Foundation
import BlocksRuntime

public final nonisolated class AlphaApi: Sendable {
    private let client: BlocksClient

    public init(client: BlocksClient) {
        self.client = client
    }

    @available(*, deprecated, message: "Use blocks.alphaApi from one Blocks() or Blocks(server:) you hold")
    public convenience init(server: BlocksServer = Servers.local) {
        self.init(client: BlocksClient(server: server))
    }

    /// Calls `alphaApi.setState`.
    public func setState(input: SetState.Input) async throws -> Bool {
        let request = BlocksRequest(method: "alphaApi.setState", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for alphaApi.setState") }
        return try JSONDecoder().decode(Bool.self, from: result)
    }

    public enum SetState {

        public struct SignIn: Codable {
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

            public struct NewPassword: Codable {
                public let newPassword: String

                public init(newPassword: String) {
                    self.newPassword = newPassword
                }
            }

            public enum ConfirmSignInChallenge: Codable {
                case code(Code)
                case newPassword(NewPassword)

                enum CodingKeys: String, CodingKey {
                    case challenge
                }

                public func encode(to encoder: Encoder) throws {
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    switch self {
                    case .code(let params):
                        try container.encode("code", forKey: .challenge)
                        try params.encode(to: encoder)
                    case .newPassword(let params):
                        try container.encode("newPassword", forKey: .challenge)
                        try params.encode(to: encoder)
                    }
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: CodingKeys.self)
                    let disc = try container.decode(String.self, forKey: .challenge)
                    switch disc {
                    case "code": self = .code(try Code(from: decoder))
                    case "newPassword": self = .newPassword(try NewPassword(from: decoder))
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
                case "confirmSignIn": self = .confirmSignIn(try ConfirmSignIn(from: decoder))
                default:
                    throw DecodingError.dataCorruptedError(forKey: .action, in: container, debugDescription: "Unknown value: \(disc)")
                }
            }
        }
    }
}

public final nonisolated class BetaApi: Sendable {
    private let client: BlocksClient

    public init(client: BlocksClient) {
        self.client = client
    }

    @available(*, deprecated, message: "Use blocks.betaApi from one Blocks() or Blocks(server:) you hold")
    public convenience init(server: BlocksServer = Servers.local) {
        self.init(client: BlocksClient(server: server))
    }

    /// Calls `betaApi.setState`.
    public func setState(input: SetState.Input) async throws -> Bool {
        let request = BlocksRequest(method: "betaApi.setState", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for betaApi.setState") }
        return try JSONDecoder().decode(Bool.self, from: result)
    }

    public enum SetState {

        public struct SignIn: Codable {
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

            public struct NewPassword: Codable {
                public let newPassword: String

                public init(newPassword: String) {
                    self.newPassword = newPassword
                }
            }

            public enum ConfirmSignInChallenge: Codable {
                case code(Code)
                case newPassword(NewPassword)

                enum CodingKeys: String, CodingKey {
                    case challenge
                }

                public func encode(to encoder: Encoder) throws {
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    switch self {
                    case .code(let params):
                        try container.encode("code", forKey: .challenge)
                        try params.encode(to: encoder)
                    case .newPassword(let params):
                        try container.encode("newPassword", forKey: .challenge)
                        try params.encode(to: encoder)
                    }
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: CodingKeys.self)
                    let disc = try container.decode(String.self, forKey: .challenge)
                    switch disc {
                    case "code": self = .code(try Code(from: decoder))
                    case "newPassword": self = .newPassword(try NewPassword(from: decoder))
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

    public let alphaApi: AlphaApi
    public let betaApi: BetaApi

    /// Defaults to the spec's first server; a `session` you pass stays yours.
    public init(
        server: BlocksRuntime.BlocksServer = Servers.local,
        session: URLSession? = nil,
        tokenStore: any BlocksRuntime.TokenStore = BlocksRuntime.InMemoryTokenStore()
    ) {
        self.server = server
        self.client = BlocksRuntime.BlocksClient(server: server, session: session, tokenStore: tokenStore)
        self.alphaApi = .init(client: client)
        self.betaApi = .init(client: client)
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