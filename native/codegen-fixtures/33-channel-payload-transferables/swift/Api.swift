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

    /// Calls `api.getAttachmentFeed`.
    public func getAttachmentFeed() async throws -> RealtimeChannel<Attachment> {
        let request = BlocksRequest(method: "api.getAttachmentFeed", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getAttachmentFeed") }
        return try self.client.makeDecoder().decode(RealtimeChannel<Attachment>.self, from: result)
    }

    /// Calls `api.getDownloadFeed`.
    public func getDownloadFeed() async throws -> RealtimeChannel<[FileDownloadHandle]> {
        let request = BlocksRequest(method: "api.getDownloadFeed", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getDownloadFeed") }
        return try self.client.makeDecoder().decode(RealtimeChannel<[FileDownloadHandle]>.self, from: result)
    }

    /// Calls `api.getLobby`.
    public func getLobby() async throws -> Lobby {
        let request = BlocksRequest(method: "api.getLobby", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getLobby") }
        return try JSONDecoder().decode(Lobby.self, from: result)
    }

    /// Calls `api.getSignInFeed`.
    public func getSignInFeed() async throws -> RealtimeChannel<SignInOption> {
        let request = BlocksRequest(method: "api.getSignInFeed", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getSignInFeed") }
        return try self.client.makeDecoder().decode(RealtimeChannel<SignInOption>.self, from: result)
    }

    /// Calls `api.getSignInBoard`.
    public func getSignInBoard() async throws -> SignInBoard {
        let request = BlocksRequest(method: "api.getSignInBoard", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getSignInBoard") }
        return try client.makeDecoder().decode(SignInBoard.self, from: result)
    }

    /// Calls `api.getProviderDirectory`.
    public func getProviderDirectory() async throws -> ProviderDirectory {
        let request = BlocksRequest(method: "api.getProviderDirectory", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getProviderDirectory") }
        return try client.makeDecoder().decode(ProviderDirectory.self, from: result)
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