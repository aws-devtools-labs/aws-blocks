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

    /// Calls `api.getBoard`.
    public func getBoard() async throws -> Board {
        let request = BlocksRequest(method: "api.getBoard", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getBoard") }
        return try JSONDecoder().decode(Board.self, from: result)
    }

    /// Calls `api.saveLayout`.
    public func saveLayout(layout: Layout) async throws -> Layout {
        let request = BlocksRequest(method: "api.saveLayout", params: [layout], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.saveLayout") }
        return try JSONDecoder().decode(Layout.self, from: result)
    }

    /// Calls `api.groupNotes`.
    public func groupNotes(groups: [String: [Note]], levels: [Level]? = nil) async throws -> [String: [Note]] {
        var _params: [any Encodable] = [groups]
        if let levels { _params.append(levels) }
        let request = BlocksRequest(method: "api.groupNotes", params: _params, id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.groupNotes") }
        return try JSONDecoder().decode([String: [Note]].self, from: result)
    }

    /// Calls `api.listFeeds`.
    public func listFeeds() async throws -> [RealtimeChannel<Note>] {
        let request = BlocksRequest(method: "api.listFeeds", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.listFeeds") }
        return try JSONDecoder().decode([RealtimeChannel<Note>].self, from: result)
    }

    /// Calls `api.getLoginMenu`.
    public func getLoginMenu() async throws -> LoginMenu {
        let request = BlocksRequest(method: "api.getLoginMenu", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getLoginMenu") }
        return try client.makeDecoder().decode(LoginMenu.self, from: result)
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