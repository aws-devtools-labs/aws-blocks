import Foundation
import BlocksRuntime

public final class Posts: Sendable {
    private let client: BlocksClient

    public init(client: BlocksClient) {
        self.client = client
    }

    @available(*, deprecated, message: "Use blocks.posts from one Blocks() or Blocks(server:) you hold")
    public convenience init(server: BlocksServer = Servers.local) {
        self.init(client: BlocksClient(server: server))
    }

    /// Calls `posts.list`.
    public func list(authorId: String) async throws -> [List.Result] {
        let request = BlocksRequest(method: "posts.list", params: [authorId], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for posts.list") }
        return try JSONDecoder().decode([List.Result].self, from: result)
    }

    /// Calls `posts.create`.
    public func create(input: Create.Input) async throws -> Create.Result {
        let request = BlocksRequest(method: "posts.create", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for posts.create") }
        return try JSONDecoder().decode(Create.Result.self, from: result)
    }

    /// Calls `posts.delete`.
    public func delete(id: String) async throws -> Delete.Result {
        let request = BlocksRequest(method: "posts.delete", params: [id], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for posts.delete") }
        return try JSONDecoder().decode(Delete.Result.self, from: result)
    }

    public enum List {

        public struct Result: Codable {
            public let authorId: String
            public let id: String
            public let title: String
        }
    }

    public enum Create {

        public struct Input: Codable {
            public let authorId: String
            public let body: String
            public let title: String
        }

        public struct Result: Codable {
            public let authorId: String
            public let id: String
            public let title: String
        }
    }

    public enum Delete {

        public struct Result: Codable {
            public let ok: Bool
        }
    }
}

public final class Users: Sendable {
    private let client: BlocksClient

    public init(client: BlocksClient) {
        self.client = client
    }

    @available(*, deprecated, message: "Use blocks.users from one Blocks() or Blocks(server:) you hold")
    public convenience init(server: BlocksServer = Servers.local) {
        self.init(client: BlocksClient(server: server))
    }

    /// Calls `users.get`.
    public func get(id: String) async throws -> User {
        let request = BlocksRequest(method: "users.get", params: [id], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for users.get") }
        return try JSONDecoder().decode(User.self, from: result)
    }

    /// Calls `users.list`.
    public func list() async throws -> [User] {
        let request = BlocksRequest(method: "users.list", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for users.list") }
        return try JSONDecoder().decode([User].self, from: result)
    }

    /// Calls `users.create`.
    public func create(input: Create.Input) async throws -> User {
        let request = BlocksRequest(method: "users.create", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for users.create") }
        return try JSONDecoder().decode(User.self, from: result)
    }

    public enum Create {

        public struct Input: Codable {
            public let email: String
            public let name: String
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

    public let posts: Posts
    public let users: Users

    /// Defaults to the spec's first server; a `session` you pass stays yours.
    public init(
        server: BlocksRuntime.BlocksServer = Servers.local,
        session: URLSession? = nil,
        tokenStore: any BlocksRuntime.TokenStore = BlocksRuntime.InMemoryTokenStore()
    ) {
        self.server = server
        self.client = BlocksRuntime.BlocksClient(server: server, session: session, tokenStore: tokenStore)
        self.posts = .init(client: client)
        self.users = .init(client: client)
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