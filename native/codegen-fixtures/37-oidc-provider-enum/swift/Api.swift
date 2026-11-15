import Foundation
import BlocksRuntime

public final nonisolated class Auth: Sendable {
    private let client: BlocksClient

    public init(client: BlocksClient) {
        self.client = client
    }

    @available(*, deprecated, message: "Use blocks.auth from one Blocks() or Blocks(server:) you hold")
    public convenience init(server: BlocksServer = Servers.local) {
        self.init(client: BlocksClient(server: server))
    }

    /// Calls `auth.getClient`.
    public func getClient() async throws -> OIDCClient<GetClient.Provider> {
        let request = BlocksRequest(method: "auth.getClient", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for auth.getClient") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw RPCError(message: "Invalid OIDC client descriptor for auth.getClient")
        }
        return try OIDCClient<GetClient.Provider>.fromJSON(descriptor, baseUrl: self.client.baseUrl, client: self.client)
    }

    public enum GetClient {

        /// The providers `auth.getClient` signs in with.
        public nonisolated enum Provider: String, CaseIterable, Codable, BlocksRuntime.OIDCProviderName {
            case google
            case github
            case mySso = "my-sso"
            case loginGov = "login.gov"
        }
    }
}

public final nonisolated class LegacyAuth: Sendable {
    private let client: BlocksClient

    public init(client: BlocksClient) {
        self.client = client
    }

    @available(*, deprecated, message: "Use blocks.legacyAuth from one Blocks() or Blocks(server:) you hold")
    public convenience init(server: BlocksServer = Servers.local) {
        self.init(client: BlocksClient(server: server))
    }

    /// Calls `legacyAuth.getClient`.
    public func getClient() async throws -> OIDCClient<String> {
        let request = BlocksRequest(method: "legacyAuth.getClient", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for legacyAuth.getClient") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw RPCError(message: "Invalid OIDC client descriptor for legacyAuth.getClient")
        }
        return try OIDCClient<String>.fromJSON(descriptor, baseUrl: self.client.baseUrl, client: self.client)
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

    public let auth: Auth
    public let legacyAuth: LegacyAuth

    /// Defaults to the spec's first server; a `session` you pass stays yours.
    public init(
        server: BlocksRuntime.BlocksServer = Servers.local,
        session: URLSession? = nil,
        tokenStore: any BlocksRuntime.TokenStore = BlocksRuntime.InMemoryTokenStore()
    ) {
        self.server = server
        self.client = BlocksRuntime.BlocksClient(server: server, session: session, tokenStore: tokenStore)
        self.auth = .init(client: client)
        self.legacyAuth = .init(client: client)
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