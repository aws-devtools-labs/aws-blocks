import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.getUser`.
    public func getUser(id: String) async throws -> GetUser.Result {
        let request = BlocksRequest(method: "api.getUser", params: [id], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getUser") }
        return try JSONDecoder().decode(GetUser.Result.self, from: result)
    }

    /// Calls `api.updateUser`.
    public func updateUser(input: UpdateUser.Input) async throws -> UpdateUser.Result {
        let request = BlocksRequest(method: "api.updateUser", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.updateUser") }
        return try JSONDecoder().decode(UpdateUser.Result.self, from: result)
    }

    public enum GetUser {

        public struct Result: Codable {
            public let metadata: [String: String]?
            public let name: String
            public let nicknames: [String?]?
            public let scores: [Int]?
            public let tags: [String]

            enum CodingKeys: String, CodingKey {
                case metadata
                case name
                case nicknames
                case scores
                case tags
            }

            public func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encodeIfPresent(self.metadata, forKey: .metadata)
                try c.encode(self.name, forKey: .name)
                try c.encodeIfPresent(self.nicknames, forKey: .nicknames)
                try c.encodeIfPresent(self.scores, forKey: .scores)
                try c.encode(self.tags, forKey: .tags)
            }

            public init(metadata: [String: String]? = nil, name: String, nicknames: [String?]? = nil, scores: [Int]? = nil, tags: [String]) {
                self.metadata = metadata
                self.name = name
                self.nicknames = nicknames
                self.scores = scores
                self.tags = tags
            }
        }
    }

    public enum UpdateUser {

        public struct Input: Codable {
            public let id: String
            public let metadata: [String: String]?
            public let tags: [String]?

            enum CodingKeys: String, CodingKey {
                case id
                case metadata
                case tags
            }

            public func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(self.id, forKey: .id)
                try c.encodeIfPresent(self.metadata, forKey: .metadata)
                try c.encodeIfPresent(self.tags, forKey: .tags)
            }

            public init(id: String, metadata: [String: String]? = nil, tags: [String]? = nil) {
                self.id = id
                self.metadata = metadata
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