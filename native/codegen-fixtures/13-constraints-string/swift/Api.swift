import Foundation
import BlocksRuntime

public final nonisolated class Api: Sendable {
    private let client: BlocksClient

    public init(client: BlocksClient) {
        self.client = client
    }

    @available(*, deprecated, message: "Use blocks.api from one Blocks() or Blocks(server:) you hold")
    public convenience init(server: BlocksServer = Servers.local) {
        self.init(client: BlocksClient(server: server))
    }

    /// Calls `api.createUser`.
    public func createUser(input: CreateUser.Input) async throws -> CreateUser.Result {
        let request = BlocksRequest(method: "api.createUser", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.createUser") }
        return try JSONDecoder().decode(CreateUser.Result.self, from: result)
    }

    public enum CreateUser {

        public struct Input: Codable {
            public let code: String
            public let email: String
            public let nickname: String?

            enum CodingKeys: String, CodingKey {
                case code
                case email
                case nickname
            }

            public func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(self.code, forKey: .code)
                try c.encode(self.email, forKey: .email)
                try c.encodeIfPresent(self.nickname, forKey: .nickname)
            }

            public init(code: String, email: String, nickname: String? = nil) throws {
                guard code.range(of: "^[A-Z]{3}$", options: .regularExpression) != nil else { throw CodegenError.validation("code must match pattern ^[A-Z]{3}$") }
                self.code = code
                guard email.count >= 5 else { throw CodegenError.validation("email must be at least 5 characters") }
                guard email.count <= 254 else { throw CodegenError.validation("email must be at most 254 characters") }
                self.email = email
                if let v = nickname {
                    guard v.count >= 2 else { throw CodegenError.validation("nickname must be at least 2 characters") }
                    guard v.count <= 30 else { throw CodegenError.validation("nickname must be at most 30 characters") }
                }
                self.nickname = nickname
            }
        }

        public struct Result: Codable {
            public let ok: Bool
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

    public let api: Api

    /// Defaults to the spec's first server; a `session` you pass stays yours.
    public init(
        server: BlocksRuntime.BlocksServer = Servers.local,
        session: URLSession? = nil,
        tokenStore: any BlocksRuntime.TokenStore = BlocksRuntime.InMemoryTokenStore()
    ) {
        self.server = server
        self.client = BlocksRuntime.BlocksClient(server: server, session: session, tokenStore: tokenStore)
        self.api = .init(client: client)
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