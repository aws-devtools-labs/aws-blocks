import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.listTags`.
    public func listTags() async throws -> [String] {
        let request = BlocksRequest(method: "api.listTags", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.listTags") }
        return try JSONDecoder().decode([String].self, from: result)
    }

    /// Calls `api.listItems`.
    public func listItems() async throws -> [ListItems.Result] {
        let request = BlocksRequest(method: "api.listItems", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.listItems") }
        return try JSONDecoder().decode([ListItems.Result].self, from: result)
    }

    public enum ListItems {

        public struct Result: Codable {
            public let id: String
            public let name: String

            public init(id: String, name: String) {
                self.id = id
                self.name = name
            }
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}