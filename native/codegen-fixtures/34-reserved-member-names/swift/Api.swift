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

    /// Calls `api.getDoc`.
    public func getDoc(_id: String, int: Int? = nil) async throws -> Doc {
        var _params: [any Encodable] = [_id]
        if let int { _params.append(int) }
        let request = BlocksRequest(method: "api.getDoc", params: _params, id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getDoc") }
        return try JSONDecoder().decode(Doc.self, from: result)
    }

    /// Calls `api.putExtras`.
    public func putExtras(extras: Extras) async throws -> Extras {
        let request = BlocksRequest(method: "api.putExtras", params: [extras], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.putExtras") }
        return try JSONDecoder().decode(Extras.self, from: result)
    }

    /// Calls `api.getLevel`.
    public func getLevel() async throws -> Level {
        let request = BlocksRequest(method: "api.getLevel", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getLevel") }
        return try JSONDecoder().decode(Level.self, from: result)
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