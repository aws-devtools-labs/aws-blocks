import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.echo`.
    public func echo(text: String, count: Int, score: Double, enabled: Bool) async throws -> Echo.Result {
        let request = BlocksRequest(method: "api.echo", params: [text, count, score, enabled], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.echo") }
        return try JSONDecoder().decode(Echo.Result.self, from: result)
    }

    public enum Echo {

        public struct Result: Codable {
            public let count: Int
            public let enabled: Bool
            public let score: Double
            public let text: String

            public init(count: Int, enabled: Bool, score: Double, text: String) {
                self.count = count
                self.enabled = enabled
                self.score = score
                self.text = text
            }
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}