import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.doAction`.
    public func doAction(input: DoAction.Input) async throws -> DoAction.Result {
        let request = BlocksRequest(method: "api.doAction", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.doAction") }
        return try JSONDecoder().decode(DoAction.Result.self, from: result)
    }

    public enum DoAction {

        public struct Create: Codable {
            public let title: String

            public init(title: String) {
                self.title = title
            }
        }

        public struct Delete: Codable {
            public let id: String

            public init(id: String) {
                self.id = id
            }
        }

        public struct Update: Codable {
            public let id: String
            public let title: String

            public init(id: String, title: String) {
                self.id = id
                self.title = title
            }
        }

        public enum Input: Codable {
            case create(Create)
            case delete(Delete)
            case update(Update)

            enum CodingKeys: String, CodingKey {
                case action
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .create(let params):
                    try container.encode("create", forKey: .action)
                    try params.encode(to: encoder)
                case .delete(let params):
                    try container.encode("delete", forKey: .action)
                    try params.encode(to: encoder)
                case .update(let params):
                    try container.encode("update", forKey: .action)
                    try params.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let disc = try container.decode(String.self, forKey: .action)
                switch disc {
                case "create": self = .create(try Create(from: decoder))
                case "delete": self = .delete(try Delete(from: decoder))
                case "update": self = .update(try Update(from: decoder))
                default:
                    throw DecodingError.dataCorruptedError(forKey: .action, in: container, debugDescription: "Unknown value: \(disc)")
                }
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