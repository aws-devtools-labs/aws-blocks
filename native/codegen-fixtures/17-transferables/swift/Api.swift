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

    /// Calls `api.getChannel`.
    public func getChannel() async throws -> RealtimeChannel<GetChannel.ResultMessage> {
        let request = BlocksRequest(method: "api.getChannel", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getChannel") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw RPCError(message: "Invalid channel descriptor for api.getChannel")
        }
        return RealtimeChannel<GetChannel.ResultMessage>.fromJSON(descriptor, baseHost: BlocksClient.baseHost) { data in
            try JSONDecoder().decode(GetChannel.ResultMessage.self, from: data)
        }
    }

    /// Calls `api.getFile`.
    public func getFile(path: String) async throws -> FileDownloadHandle {
        let request = BlocksRequest(method: "api.getFile", params: [path], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getFile") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw RPCError(message: "Invalid file descriptor for api.getFile")
        }
        return try FileDownloadHandle.fromJSON(descriptor)
    }

    /// Calls `api.getUpload`.
    public func getUpload(path: String) async throws -> FileUploadHandle {
        let request = BlocksRequest(method: "api.getUpload", params: [path], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getUpload") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw RPCError(message: "Invalid file descriptor for api.getUpload")
        }
        return try FileUploadHandle.fromJSON(descriptor)
    }

    public enum GetChannel {

        public struct ResultMessage: Codable {
            public let message: String
            public let timestamp: Double
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