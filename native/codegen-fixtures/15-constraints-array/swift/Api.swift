import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.setTags`.
    public func setTags(input: SetTags.Input) async throws -> SetTags.Result {
        let request = BlocksRequest(method: "api.setTags", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.setTags") }
        return try JSONDecoder().decode(SetTags.Result.self, from: result)
    }

    public enum SetTags {

        public struct Input: Codable {
            public let tags: [String]

            public init(tags: [String]) throws {
                guard tags.count >= 1 else { throw CodegenError.validation("tags must have at least 1 items") }
                guard tags.count <= 10 else { throw CodegenError.validation("tags must have at most 10 items") }
                self.tags = tags
            }
        }

        public struct Result: Codable {
            public let ok: Bool

            public init(ok: Bool) {
                self.ok = ok
            }
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}