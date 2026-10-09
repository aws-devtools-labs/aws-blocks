import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.getTodo`.
    public func getTodo(id: String) async throws -> Todo {
        let request = BlocksRequest(method: "api.getTodo", params: [id], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getTodo") }
        return try JSONDecoder().decode(Todo.self, from: result)
    }

    /// Calls `api.createTodo`.
    public func createTodo(input: CreateTodo.Input) async throws -> Todo {
        let request = BlocksRequest(method: "api.createTodo", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.createTodo") }
        return try JSONDecoder().decode(Todo.self, from: result)
    }

    public enum CreateTodo {

        public struct Input: Codable {
            public let priority: Int
            public let title: String

            public init(priority: Int, title: String) {
                self.priority = priority
                self.title = title
            }
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}