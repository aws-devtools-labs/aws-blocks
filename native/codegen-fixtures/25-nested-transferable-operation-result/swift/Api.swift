import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.getSession`.
    public func getSession() async throws -> GetSession.Result {
        let request = BlocksRequest(method: "api.getSession", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getSession") }
        return try JSONDecoder().decode(GetSession.Result.self, from: result)
    }

    /// Calls `api.getOtherSession`.
    public func getOtherSession() async throws -> GetOtherSession.Result {
        let request = BlocksRequest(method: "api.getOtherSession", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getOtherSession") }
        return try JSONDecoder().decode(GetOtherSession.Result.self, from: result)
    }

    public enum GetSession {

        public struct Result: Codable {
            public let channel: RealtimeChannel<ChannelMessage>
            public let event: Event
            public let inner: Inner
            public let integerValues: RealtimeChannel<[Int]>
            public let sessionId: String
            public let stringValues: RealtimeChannel<[String]>

            public struct ChannelMessage: Codable {
                public let text: String
            }

            public struct Message: Codable {
                public let channel: RealtimeChannel<ChannelMessage>

                public struct ChannelMessage: Codable {
                    public let body: String
                }
            }

            public struct Presence: Codable {
                public let channel: RealtimeChannel<ChannelMessage>

                public struct ChannelMessage: Codable {
                    public let online: Bool
                }
            }

            public enum Event: Codable {
                case message(Message)
                case presence(Presence)

                enum CodingKeys: String, CodingKey {
                    case kind
                }

                public func encode(to encoder: Encoder) throws {
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    switch self {
                    case .message(let params):
                        try container.encode("message", forKey: .kind)
                        try params.encode(to: encoder)
                    case .presence(let params):
                        try container.encode("presence", forKey: .kind)
                        try params.encode(to: encoder)
                    }
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: CodingKeys.self)
                    let disc = try container.decode(String.self, forKey: .kind)
                    switch disc {
                    case "message": self = .message(try Message(from: decoder))
                    case "presence": self = .presence(try Presence(from: decoder))
                    default:
                        throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "Unknown value: \(disc)")
                    }
                }
            }

            public struct Inner: Codable {
                public let channel: RealtimeChannel<ChannelMessage>

                public struct ChannelMessage: Codable {
                    public let count: Int
                }
            }
        }
    }

    public enum GetOtherSession {

        public struct Result: Codable {
            public let channel: RealtimeChannel<ChannelMessage>

            public struct ChannelMessage: Codable {
                public let count: Int
            }
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}