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

    /// Calls `api.search`.
    public func search(query: Search.Query) async throws -> Search.Result {
        let request = BlocksRequest(method: "api.search", params: [query], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.search") }
        return try JSONDecoder().decode(Search.Result.self, from: result)
    }

    /// Calls `api.getValue`.
    public func getValue() async throws -> String? {
        let request = BlocksRequest(method: "api.getValue", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { return nil }
        return try JSONDecoder().decode(String.self, from: result)
    }

    public enum Search {

        public struct Query_Variant1: Codable {
            public let fuzzy: Bool?
            public let text: String

            enum CodingKeys: String, CodingKey {
                case fuzzy
                case text
            }

            public func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encodeIfPresent(self.fuzzy, forKey: .fuzzy)
                try c.encode(self.text, forKey: .text)
            }
        }

        public enum Query: Codable {
            case query_Variant0
            case query_Variant1(Query_Variant1)

            public func encode(to encoder: Encoder) throws {
                switch self {
                case .query_Variant0:
                    _ = encoder.container(keyedBy: EmptyKey.self)
                case .query_Variant1(let payload):
                    try payload.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                if let value = try? Query_Variant1(from: decoder) {
                    self = .query_Variant1(value)
                    return
                }
                self = .query_Variant0
            }

            private enum EmptyKey: CodingKey {}
        }

        public struct Result: Codable {
            public let count: Int
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