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

    /// Calls `api.relay`.
    public func relay(feed: RealtimeChannel<Note>) async throws -> String {
        let request = BlocksRequest(method: "api.relay", params: [feed], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.relay") }
        return try JSONDecoder().decode(String.self, from: result)
    }

    /// Calls `api.relayIfAny`.
    public func relayIfAny(room: String, feed: RealtimeChannel<Note>? = nil) async throws -> String {
        var _params: [any Encodable] = [room]
        if let feed { _params.append(feed) }
        let request = BlocksRequest(method: "api.relayIfAny", params: _params, id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.relayIfAny") }
        return try JSONDecoder().decode(String.self, from: result)
    }

    /// Calls `api.relayOrNull`.
    public func relayOrNull(feed: RealtimeChannel<Note>?) async throws -> String {
        let request = BlocksRequest(method: "api.relayOrNull", params: [feed], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.relayOrNull") }
        return try JSONDecoder().decode(String.self, from: result)
    }

    /// Calls `api.relayAll`.
    public func relayAll(feeds: [RealtimeChannel<Note>], byRoom: [String: RealtimeChannel<Note>]) async throws -> String {
        let request = BlocksRequest(method: "api.relayAll", params: [feeds, byRoom], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.relayAll") }
        return try JSONDecoder().decode(String.self, from: result)
    }

    /// Calls `api.relayInline`.
    public func relayInline(feed: RealtimeChannel<RelayInline.FeedMessage>) async throws -> String {
        let request = BlocksRequest(method: "api.relayInline", params: [feed], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.relayInline") }
        return try JSONDecoder().decode(String.self, from: result)
    }

    /// Calls `api.share`.
    public func share(download: FileDownloadHandle, upload: FileUploadHandle) async throws -> String {
        let request = BlocksRequest(method: "api.share", params: [download, upload], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.share") }
        return try JSONDecoder().decode(String.self, from: result)
    }

    /// Calls `api.forward`.
    public func forward(bundle: Bundle) async throws -> String {
        let request = BlocksRequest(method: "api.forward", params: [bundle], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.forward") }
        return try JSONDecoder().decode(String.self, from: result)
    }

    public enum RelayInline {

        public struct FeedMessage: Codable {
            public let text: String

            public init(text: String) {
                self.text = text
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