import Foundation
import BlocksRuntime

public class Posts {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
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

            public init(authorId: String, id: String, title: String) {
                self.authorId = authorId
                self.id = id
                self.title = title
            }
        }
    }

    public enum Create {

        public struct Input: Codable {
            public let authorId: String
            public let body: String
            public let title: String

            public init(authorId: String, body: String, title: String) {
                self.authorId = authorId
                self.body = body
                self.title = title
            }
        }

        public struct Result: Codable {
            public let authorId: String
            public let id: String
            public let title: String

            public init(authorId: String, id: String, title: String) {
                self.authorId = authorId
                self.id = id
                self.title = title
            }
        }
    }

    public enum Delete {

        public struct Result: Codable {
            public let ok: Bool

            public init(ok: Bool) {
                self.ok = ok
            }
        }
    }
}

public class Users {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
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

            public init(email: String, name: String) {
                self.email = email
                self.name = name
            }
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}