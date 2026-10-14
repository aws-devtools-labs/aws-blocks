import Foundation
import BlocksRuntime

public final class Api: Sendable {
    private let client: BlocksClient

    public init(client: BlocksClient) {
        self.client = client
    }

    @available(*, deprecated, message: "Use blocks.api from one Blocks() or Blocks(server:) you hold")
    public convenience init(server: BlocksServer = Servers.local) {
        self.init(client: BlocksClient(server: server))
    }

    /// Calls `api.doAction`.
    public func doAction(input: DoAction.Input) async throws -> DoAction.Result {
        let request = BlocksRequest(method: "api.doAction", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.doAction") }
        return try JSONDecoder().decode(DoAction.Result.self, from: result)
    }

    public enum DoAction {

        public struct Create: Codable {
            public let title: String
        }

        public struct Delete: Codable {
            public let id: String
        }

        public struct Update: Codable {
            public let id: String
            public let title: String
        }

        public enum Input: Codable {
            case create(Create)
            case delete(Delete)
            case update(Update)

            enum CodingKeys: String, CodingKey {
                case action
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .create(let params):
                    try container.encode("create", forKey: .action)
                    try params.encode(to: encoder)
                case .delete(let params):
                    try container.encode("delete", forKey: .action)
                    try params.encode(to: encoder)
                case .update(let params):
                    try container.encode("update", forKey: .action)
                    try params.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let disc = try container.decode(String.self, forKey: .action)
                switch disc {
                case "create": self = .create(try Create(from: decoder))
                case "delete": self = .delete(try Delete(from: decoder))
                case "update": self = .update(try Update(from: decoder))
                default:
                    throw DecodingError.dataCorruptedError(forKey: .action, in: container, debugDescription: "Unknown value: \(disc)")
                }
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
public final class Blocks: Sendable {
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

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}