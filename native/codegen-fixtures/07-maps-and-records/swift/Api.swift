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

    /// Calls `api.getScores`.
    public func getScores() async throws -> [String: Double] {
        let request = BlocksRequest(method: "api.getScores", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getScores") }
        return try JSONDecoder().decode([String: Double].self, from: result)
    }

    /// Calls `api.signUp`.
    public func signUp(input: SignUp.Input) async throws -> SignUp.Result {
        let request = BlocksRequest(method: "api.signUp", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.signUp") }
        return try JSONDecoder().decode(SignUp.Result.self, from: result)
    }

    public enum SignUp {

        public struct Input: Codable {
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

        public struct Result: Codable {
            public let ok: Bool

            public init(ok: Bool) {
                self.ok = ok
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