import Foundation
import BlocksRuntime

public final nonisolated class Api: Sendable {
    private let client: BlocksClient

    public init(client: BlocksClient) {
        self.client = client
    }

    @available(*, deprecated, message: "Use blocks.api from one Blocks() or Blocks(server:) you hold")
    public convenience init(server: BlocksServer = Servers.primary) {
        self.init(client: BlocksClient(server: server))
    }

    /// Calls `api.get$x`.
    public func get_x(id: String) async throws -> Widget {
        let request = BlocksRequest(method: "api.get$x", params: [id], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.get$x") }
        return try JSONDecoder().decode(Widget.self, from: result)
    }

    /// Calls `api.doAction`.
    public func doAction(input: DoAction.Input) async throws -> DoAction.Result {
        let request = BlocksRequest(method: "api.doAction", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.doAction") }
        return try JSONDecoder().decode(DoAction.Result.self, from: result)
    }

    public enum DoAction {

        public struct Actioncreate_: Codable {
            public let title: String

            public init(title: String) {
                self.title = title
            }
        }

        public struct Actionre_move: Codable {
            public let id: String

            public init(id: String) {
                self.id = id
            }
        }

        public enum Input: Codable {
            case actioncreate_(Actioncreate_)
            case actionre_Move(Actionre_move)

            enum CodingKeys: String, CodingKey {
                case action
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .actioncreate_(let params):
                    try container.encode("create$", forKey: .action)
                    try params.encode(to: encoder)
                case .actionre_Move(let params):
                    try container.encode("re$move", forKey: .action)
                    try params.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let disc = try container.decode(String.self, forKey: .action)
                switch disc {
                case "create$": self = .actioncreate_(try Actioncreate_(from: decoder))
                case "re$move": self = .actionre_Move(try Actionre_move(from: decoder))
                default:
                    throw DecodingError.dataCorruptedError(forKey: .action, in: container, debugDescription: "Unknown value: \(disc)")
                }
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
        server: BlocksRuntime.BlocksServer = Servers.primary,
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
    public static let primary = BlocksServer(name: "primary", url: "https://example.com/a'b$c${x}\"d\\e")
}