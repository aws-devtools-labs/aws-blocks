import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.getCoords`.
    public func getCoords() async throws -> GetCoords.Result {
        let request = BlocksRequest(method: "api.getCoords", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getCoords") }
        return try JSONDecoder().decode(GetCoords.Result.self, from: result)
    }

    /// Calls `api.getPair`.
    public func getPair() async throws -> GetPair.Result {
        let request = BlocksRequest(method: "api.getPair", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getPair") }
        return try JSONDecoder().decode(GetPair.Result.self, from: result)
    }

    public enum GetCoords {

        public struct Result: Codable {
            public let item0: Double
            public let item1: Double
            public let item2: String

            public init(item0: Double, item1: Double, item2: String) {
                self.item0 = item0
                self.item1 = item1
                self.item2 = item2
            }
        }
    }

    public enum GetPair {

        public struct Result: Codable {
            public let item0: String
            public let item1: Int

            public init(item0: String, item1: Int) {
                self.item0 = item0
                self.item1 = item1
            }
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}