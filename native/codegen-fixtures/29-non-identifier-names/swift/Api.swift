import Foundation
import BlocksRuntime

public final nonisolated class Api: Sendable {
    private let client: BlocksClient

    public init(client: BlocksClient) {
        self.client = client
    }

    @available(*, deprecated, message: "Use blocks.api from one Blocks() or Blocks(server:) you hold")
    public convenience init(server: BlocksServer = Servers.main___val_x___1___) {
        self.init(client: BlocksClient(server: server))
    }

    /// Calls `api.get\"Sample`;x`.
    public func get_Sample__x(run___error__xParam________p: String, item: Sample_Type__x___, opt_ional_: Int? = nil) async throws -> Sample_Type__x___ {
        var _params: [any Encodable] = [run___error__xParam________p, item]
        if let opt_ional_ { _params.append(opt_ional_) }
        let request = BlocksRequest(method: "api.get\"Sample`;x", params: _params, id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.get\"Sample`;x") }
        return try JSONDecoder().decode(Sample_Type__x___.self, from: result)
    }
}

public final nonisolated class Ns: Sendable {
    private let client: BlocksClient

    public init(client: BlocksClient) {
        self.client = client
    }

    @available(*, deprecated, message: "Use blocks.ns from one Blocks() or Blocks(server:) you hold")
    public convenience init(server: BlocksServer = Servers.main___val_x___1___) {
        self.init(client: BlocksClient(server: server))
    }

    /// Calls `ns.do`Action`.
    public func do_Action(input: Do_Action.Input) async throws -> Do_Action.Result {
        let request = BlocksRequest(method: "ns.do`Action", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for ns.do`Action") }
        return try JSONDecoder().decode(Do_Action.Result.self, from: result)
    }

    public enum Do_Action {

        public struct Cre_ate: Codable {
            public let ti_tle: String

            enum CodingKeys: String, CodingKey {
                case ti_tle = "ti;tle"
            }
        }

        public struct Re_move: Codable {
            public let __id_: String

            enum CodingKeys: String, CodingKey {
                case __id_ = "${id}"
            }
        }

        public enum Input: Codable {
            case cre_Ate(Cre_ate)
            case re_Move(Re_move)

            enum CodingKeys: String, CodingKey {
                case ty_pe = "ty pe"
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .cre_Ate(let params):
                    try container.encode("cre\"ate", forKey: .ty_pe)
                    try params.encode(to: encoder)
                case .re_Move(let params):
                    try container.encode("re`move", forKey: .ty_pe)
                    try params.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let disc = try container.decode(String.self, forKey: .ty_pe)
                switch disc {
                case "cre\"ate": self = .cre_Ate(try Cre_ate(from: decoder))
                case "re`move": self = .re_Move(try Re_move(from: decoder))
                default:
                    throw DecodingError.dataCorruptedError(forKey: .ty_pe, in: container, debugDescription: "Unknown value: \(disc)")
                }
            }
        }

        public struct Result: Codable {
            public let ok_: Bool

            enum CodingKeys: String, CodingKey {
                case ok_ = "ok`"
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
    public let ns: Ns

    /// Defaults to the spec's first server; a `session` you pass stays yours.
    public init(
        server: BlocksRuntime.BlocksServer = Servers.main___val_x___1___,
        session: URLSession? = nil,
        tokenStore: any BlocksRuntime.TokenStore = BlocksRuntime.InMemoryTokenStore()
    ) {
        self.server = server
        self.client = BlocksRuntime.BlocksClient(server: server, session: session, tokenStore: tokenStore)
        self.api = .init(client: client)
        self.ns = .init(client: client)
    }

    /// Later calls throw ClientClosedError; calls in flight finish, then the session this instance created is released.
    public func close() {
        client.close()
    }
}

// MARK: - Servers

public nonisolated enum Servers {
    public static let main___val_x___1___ = BlocksServer(name: "main\"; val x = 1 //", url: "https://example.com")
}