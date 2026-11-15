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

    /// Calls `api.getTree`.
    public func getTree(root: TreeNode) async throws -> TreeNode {
        let request = BlocksRequest(method: "api.getTree", params: [root], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getTree") }
        return try JSONDecoder().decode(TreeNode.self, from: result)
    }

    /// Calls `api.getThread`.
    public func getThread() async throws -> Comment {
        let request = BlocksRequest(method: "api.getThread", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getThread") }
        return try JSONDecoder().decode(Comment.self, from: result)
    }

    /// Calls `api.getCategory`.
    public func getCategory() async throws -> Category? {
        let request = BlocksRequest(method: "api.getCategory", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { return nil }
        return try JSONDecoder().decode(Category.self, from: result)
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