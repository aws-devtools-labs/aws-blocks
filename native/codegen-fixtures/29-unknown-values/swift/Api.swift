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

    /// Calls `api.echo`.
    public func echo(payload: JSONValue) async throws -> JSONValue {
        let request = BlocksRequest(method: "api.echo", params: [payload], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.echo") }
        return try JSONDecoder().decode(JSONValue.self, from: result)
    }

    /// Calls `api.store`.
    public func store(entry: Entry) async throws -> Entry {
        let request = BlocksRequest(method: "api.store", params: [entry], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.store") }
        return try JSONDecoder().decode(Entry.self, from: result)
    }

    /// Calls `api.collect`.
    public func collect(items: [JSONValue], metadata: [String: JSONValue], maybe: JSONValue?, holes: [JSONValue?], sparse: [String: JSONValue?], extra: JSONValue? = nil) async throws -> [JSONValue] {
        var _params: [any Encodable] = [items, metadata, maybe, holes, sparse]
        if let extra { _params.append(extra) }
        let request = BlocksRequest(method: "api.collect", params: _params, id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.collect") }
        return try JSONDecoder().decode([JSONValue].self, from: result)
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