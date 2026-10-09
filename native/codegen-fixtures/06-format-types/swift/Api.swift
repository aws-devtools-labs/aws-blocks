import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.getEvent`.
    public func getEvent(id: UUID) async throws -> GetEvent.Result {
        let request = BlocksRequest(method: "api.getEvent", params: [id], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getEvent") }
        return try client.makeDecoder().decode(GetEvent.Result.self, from: result)
    }

    public enum GetEvent {

        public struct Result: Codable {
            public let createdAt: Date
            public let date: String
            public let email: String
            public let id: UUID
            public let time: String
            public let url: URL

            public init(createdAt: Date, date: String, email: String, id: UUID, time: String, url: URL) {
                self.createdAt = createdAt
                self.date = date
                self.email = email
                self.id = id
                self.time = time
                self.url = url
            }
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}