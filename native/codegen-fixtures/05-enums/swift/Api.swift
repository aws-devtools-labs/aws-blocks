import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.setStatus`.
    public func setStatus(status: SetStatus.Status) async throws -> SetStatus.Result {
        let request = BlocksRequest(method: "api.setStatus", params: [status], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.setStatus") }
        return try JSONDecoder().decode(SetStatus.Result.self, from: result)
    }

    public enum SetStatus {

        public enum Status: String, Codable {
            case active
            case inactive
            case pending
        }

        public struct Result: Codable {
            public let status: Status
            public let updatedAt: String

            public init(status: Status, updatedAt: String) {
                self.status = status
                self.updatedAt = updatedAt
            }

            public enum Status: String, Codable {
                case active
                case inactive
                case pending
            }
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}