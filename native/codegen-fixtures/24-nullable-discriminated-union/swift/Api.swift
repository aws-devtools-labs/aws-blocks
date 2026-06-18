import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.updateAttributes`.
    public func updateAttributes(attributes: [String: String]) async throws -> [String: UpdateAttributes.ResultValue] {
        let request = BlocksRequest(method: "api.updateAttributes", params: [attributes], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.updateAttributes") }
        return try JSONDecoder().decode([String: UpdateAttributes.ResultValue].self, from: result)
    }

    /// Calls `api.getNotification`.
    public func getNotification(id: String) async throws -> GetNotification.Result {
        let request = BlocksRequest(method: "api.getNotification", params: [id], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getNotification") }
        return try JSONDecoder().decode(GetNotification.Result.self, from: result)
    }

    public enum UpdateAttributes {

        public struct IsUpdatedFalse: Codable {
            public let nextStep: NextStep

            public struct NextStep: Codable {
                public let destination: String
                public let name: String
            }
        }

        public enum ResultValue: Codable {
            case isUpdatedTrue
            case isUpdatedFalse(IsUpdatedFalse)

            enum CodingKeys: String, CodingKey {
                case isUpdated
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .isUpdatedTrue:
                    try container.encode("true", forKey: .isUpdated)
                case .isUpdatedFalse(let params):
                    try container.encode("false", forKey: .isUpdated)
                    try params.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let disc = try container.decode(String.self, forKey: .isUpdated)
                switch disc {
                case "true": self = .isUpdatedTrue
                case "false": self = .isUpdatedFalse(try IsUpdatedFalse(from: decoder))
                default:
                    throw DecodingError.dataCorruptedError(forKey: .isUpdated, in: container, debugDescription: "Unknown value: \(disc)")
                }
            }
        }
    }

    public enum GetNotification {

        public struct Email: Codable {
            public let body: String
            public let subject: String
        }

        public struct Sms: Codable {
            public let message: String
        }

        public enum Result: Codable {
            case email(Email)
            case sms(Sms)

            enum CodingKeys: String, CodingKey {
                case `type`
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .email(let params):
                    try container.encode("email", forKey: .`type`)
                    try params.encode(to: encoder)
                case .sms(let params):
                    try container.encode("sms", forKey: .`type`)
                    try params.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let disc = try container.decode(String.self, forKey: .`type`)
                switch disc {
                case "email": self = .email(try Email(from: decoder))
                case "sms": self = .sms(try Sms(from: decoder))
                default:
                    throw DecodingError.dataCorruptedError(forKey: .`type`, in: container, debugDescription: "Unknown value: \(disc)")
                }
            }
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}