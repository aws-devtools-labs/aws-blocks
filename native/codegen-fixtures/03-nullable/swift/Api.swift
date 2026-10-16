import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.getProfile`.
    public func getProfile(userId: String) async throws -> GetProfile.Result {
        let request = BlocksRequest(method: "api.getProfile", params: [userId], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getProfile") }
        return try JSONDecoder().decode(GetProfile.Result.self, from: result)
    }

    public enum GetProfile {

        public struct Result: Codable {
            public let age: Int?
            public let bio: String?
            public let name: String

            enum CodingKeys: String, CodingKey {
                case age
                case bio
                case name
            }

            public func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encodeIfPresent(self.age, forKey: .age)
                try c.encodeIfPresent(self.bio, forKey: .bio)
                try c.encode(self.name, forKey: .name)
            }

            public init(age: Int? = nil, bio: String? = nil, name: String) {
                self.age = age
                self.bio = bio
                self.name = name
            }
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}