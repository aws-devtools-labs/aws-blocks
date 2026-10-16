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

        public enum Input: Codable {
            case signOut
            case mfaChallenge(MfaChallenge)

            enum CodingKeys: String, CodingKey {
                case action
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .signOut:
                    try container.encode("signOut", forKey: .action)
                case .mfaChallenge(let params):
                    try container.encode("mfa", forKey: .action)
                    try params.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let disc = try container.decode(String.self, forKey: .action)
                switch disc {
                case "signOut": self = .signOut
                case "mfa": self = .mfaChallenge(try MfaChallenge(from: decoder))
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