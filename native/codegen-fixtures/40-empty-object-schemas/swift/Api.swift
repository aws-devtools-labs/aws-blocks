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

    /// Calls `api.getOptions`.
    public func getOptions(options: GetOptions.Options, extra: GetOptions.Extra? = nil) async throws -> GetOptions.Result {
        var _params: [any Encodable] = [options]
        if let extra { _params.append(extra) }
        let request = BlocksRequest(method: "api.getOptions", params: _params, id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getOptions") }
        return try JSONDecoder().decode(GetOptions.Result.self, from: result)
    }

    /// Calls `api.getSettings`.
    public func getSettings(settings: Settings) async throws -> Settings {
        let request = BlocksRequest(method: "api.getSettings", params: [settings], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getSettings") }
        return try JSONDecoder().decode(Settings.self, from: result)
    }

    /// Calls `api.getEnvelope`.
    public func getEnvelope() async throws -> GetEnvelope.Result {
        let request = BlocksRequest(method: "api.getEnvelope", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getEnvelope") }
        return try JSONDecoder().decode(GetEnvelope.Result.self, from: result)
    }

    public enum GetOptions {

        public struct Options: Codable {

            public init() {
            }
        }

        public struct Extra: Codable {

            public init() {
            }
        }

        public struct Result: Codable {

            public init() {
            }
        }
    }

    public enum GetEnvelope {

        public struct Result: Codable {
            public let attachments: [Attachment]
            public let id: String
            public let meta: Meta
            public let settings: Settings?

            enum CodingKeys: String, CodingKey {
                case attachments
                case id
                case meta
                case settings
            }

            public func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(self.attachments, forKey: .attachments)
                try c.encode(self.id, forKey: .id)
                try c.encode(self.meta, forKey: .meta)
                try c.encodeIfPresent(self.settings, forKey: .settings)
            }

            public init(attachments: [Attachment], id: String, meta: Meta, settings: Settings? = nil) {
                self.attachments = attachments
                self.id = id
                self.meta = meta
                self.settings = settings
            }

            public struct Attachment: Codable {

                public init() {
                }
            }

            public struct Meta: Codable {

                public init() {
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